import twilio from 'twilio';
import { Groq } from "groq-sdk";
import textToSpeech from '@google-cloud/text-to-speech';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';

// Load environment variables from .env file for local development
dotenv.config();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Debug log to verify Cloudinary env variables
console.log('Cloudinary config loaded:', {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET ? '***' : undefined
});

// Twilio REST client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
// Use MessagingResponse for sandbox webhook replies
const MessagingResponse = twilio.twiml.MessagingResponse;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 30000 });

// Google TTS client and language mappings
// Initialize Google TTS client using credentials JSON from env var
const ttsCredentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '{}');
const ttsClient = new textToSpeech.TextToSpeechClient({
  credentials: ttsCredentials
});
const languageMap = {
  en: 'en-US',
  hi: 'hi-IN',
  ta: 'ta-IN',
  bn: 'bn-IN',
  mr: 'mr-IN',
  ml: 'ml-IN',
  te: 'te-IN',
  pa: 'pa-IN', // Punjabi
  gu: 'gu-IN', // Gujarati
  kn: 'kn-IN', // Kannada
  or: 'or-IN', // Odia
  ur: 'ur-IN', // Urdu
  as: 'as-IN', // Assamese
  ne: 'ne-IN', // Nepali
  sa: 'sa-IN'  // Sanskrit
};
console.log('Supported languageMap:', languageMap);

// Parse language prefix like 'hi: question' to extract lang code and text
function parseLanguagePref(raw) {
  const m = raw.match(/^([a-z]{2}):\s*(.*)/i);
  if (m) return { lang: m[1].toLowerCase(), text: m[2] };
  return { lang: 'en', text: raw };
}

// Helper to call GROQ
async function getGroqResponse(message, language = 'en') {
  const completion = await Promise.race([
    groq.chat.completions.create({
      messages: [
        { role: "system", content: `You are an expert in Indian mythology. Provide brief, engaging 2-3 sentence explanations in ${language}.` },
        { role: "user", content: `Tell me about this Indian mythology topic: ${message}` }
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens: 200,
      top_p: 1,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('GROQ request timeout')), 25000))
  ]);
  return completion.choices[0].message.content;
}

// Helper to fetch a detailed response for audio (longer form)
async function getGroqLongResponse(message, language = 'en') {
  const completion = await Promise.race([
    groq.chat.completions.create({
      messages: [
        { role: "system", content: `You are an expert in Indian mythology. Provide a detailed explanation in 2-3 paragraphs in ${language}, rich with context and storytelling.` },
        { role: "user", content: `Please provide a more detailed answer for: ${message}` }
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.8,
      max_tokens: 600,
      top_p: 1,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('GROQ long request timeout')), 45000))
  ]);
  return completion.choices[0].message.content;
}

// Generate audio file in tmp and upload to Cloudinary
async function generateAudioAndUpload(text, language = 'en') {
   const filename = `audio_${Date.now()}.mp3`;
   const tmpDir = os.tmpdir();
   const filePath = path.join(tmpDir, filename);
   // synthesize speech with Google Cloud Text-to-Speech
   const langCode = languageMap[language] || 'en-US';
   const [response] = await ttsClient.synthesizeSpeech({
     input: { text },
     voice: { languageCode: langCode, ssmlGender: 'NEUTRAL' },
     audioConfig: { audioEncoding: 'MP3' }
   });
   // write audio content to file
   fs.writeFileSync(filePath, response.audioContent, 'binary');

   // upload audio privately as authenticated mp3
   const uploadResult = await cloudinary.uploader.upload(filePath, {
     resource_type: 'video',
     folder: 'whatsapp_audio',
     use_filename: true,
     unique_filename: false,
     format: 'mp3',
     type: 'authenticated'
   });
   console.log('Cloudinary private upload result:', uploadResult.public_id);
   // generate a signed, expiring URL (1 hour)
   const expiresAt = Math.floor(Date.now() / 1000) + 3600;
   const signedUrl = cloudinary.url(uploadResult.public_id, {
     resource_type: 'video',
     format: 'mp3',
     type: 'authenticated',
     sign_url: true,
     expires_at: expiresAt,
     secure: true
   });
   console.log('Signed streaming audio URL:', signedUrl);
   // cleanup temp file
   fs.unlinkSync(filePath);
   return signedUrl;
}

// disable default body parser
export const config = { api: { bodyParser: false } };
async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('WhatsApp bot running');
  const params = await parseBody(req);
  const incoming = params.get('Body') || '';
  const from = params.get('From');

  // extract language and clean text
  const { lang, text: incomingText } = parseLanguagePref(incoming);

  try {
    // Fetch short text for chat and detailed text for audio
    const shortText = await getGroqResponse(incomingText, lang);
    let mediaUrl = null;
    try {
      console.log('Generating detailed audio response in', lang);
      const longText = await getGroqLongResponse(incomingText, lang);
      mediaUrl = await generateAudioAndUpload(longText, lang);
      console.log('Generated audio URL from long response:', mediaUrl);
    } catch (err) {
      console.error('Error generating/uploading audio:', err);
    }

    // In sandbox, reply via TwiML: short text plus audio link
    const twiml = new MessagingResponse();
    if (mediaUrl) {
      // send brief text with attached audio player
      const msg = twiml.message(shortText);
      msg.media(mediaUrl);
      // also send streaming link in a follow-up message
      twiml.message(`🔊 Listen here: ${mediaUrl}`);
    } else {
      twiml.message(shortText);
    }
    console.log('Sending TwiML with media link:', twiml.toString());
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  } catch (err) {
    console.error('Handler error:', err);
    // Send fallback via TwiML
    const twiml = new MessagingResponse();
    twiml.message('Sorry, something went wrong. Please try again later.');
    res.writeHead(500, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  }
}
