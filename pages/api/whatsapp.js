import twilio from 'twilio';
import { Groq } from "groq-sdk";
// import textToSpeech from '@google-cloud/text-to-speech';
// import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
// import gTTS from 'gtts';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';

// Load environment variables from .env file for local development
dotenv.config();

// In-memory map to store each user's language preference (resets on cold start)
const userLanguagePreference = new Map();

// Human-readable names for supported languages
const languageNames = {
  en: 'English', hi: 'Hindi', ta: 'Tamil', bn: 'Bengali', mr: 'Marathi', ml: 'Malayalam',
  te: 'Telugu', pa: 'Punjabi', gu: 'Gujarati', kn: 'Kannada', or: 'Odia', ur: 'Urdu',
  as: 'Assamese', ne: 'Nepali', sa: 'Sanskrit'
};

// Initialize AWS Polly client
// const pollyClient = new PollyClient({ region: process.env.AWS_REGION });  // AWS Polly disabled

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
// Initialize Google TTS client: use JSON env var, key file path, or default ADC
let ttsClient;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    ttsClient = new textToSpeech.TextToSpeechClient({ credentials: creds });
    console.log('TTS client initialized with JSON credentials.');
  } catch (e) {
    console.error('Invalid JSON in GOOGLE_APPLICATION_CREDENTIALS_JSON:', e);
  }
}
if (!ttsClient && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  // fallback to keyFilename path
  ttsClient = new textToSpeech.TextToSpeechClient({ keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS });
  console.log('TTS client initialized with keyFilename from env.');
}
if (!ttsClient) {
  // fallback to Application Default Credentials
  ttsClient = new textToSpeech.TextToSpeechClient();
  console.log('TTS client initialized with default credentials.');
}
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
  // Use Sarvam.ai for Indian languages
  if (language !== 'en') {
    // Sarvam.ai TTS request
    const res = await fetch('https://api.sarvam.ai/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SARVAM_API_KEY}`
      },
      body: JSON.stringify({ text, language })
    });
    if (!res.ok) {
      throw new Error(`Sarvam TTS failed: ${res.statusText}`);
    }
    const arrayBuf = await res.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(arrayBuf));
  } else {
    // For English, you can uncomment and use previous logic below:
    /*
    // Original English TTS logic:
    // synthesize speech: try AWS Polly first, then Google Cloud TTS, fallback to gTTS
    try {
      const langCode = languageMap[language] || 'en-US';
      const pollyParams = { OutputFormat: 'mp3', Text: text, VoiceId: process.env.AWS_POLLY_VOICE_ID || 'Aditi', LanguageCode: langCode };
      const pollyCmd = new SynthesizeSpeechCommand(pollyParams);
      const pollyRes = await pollyClient.send(pollyCmd);
      const chunks = []; for await (const c of pollyRes.AudioStream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      fs.writeFileSync(filePath, Buffer.concat(chunks));
    } catch (err) {
      try {
        const [gcpResp] = await ttsClient.synthesizeSpeech({ input:{ text }, voice:{ languageCode: 'en-US', ssmlGender:'NEUTRAL' }, audioConfig:{ audioEncoding:'MP3' } });
        fs.writeFileSync(filePath, gcpResp.audioContent, 'binary');
      } catch {
        new gTTS(text, language).save(filePath, () => {});
      }
    }
    */
  }
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

  const incomingTextRaw = incoming.trim().toLowerCase();
  // If user has not set a language yet and didn't send a code, show interactive list
  if (!userLanguagePreference.has(from) && !languageMap[incomingTextRaw]) {
    // Build sections for list message
    const rows = Object.entries(languageNames).map(([code, name]) => ({ id: code, title: name }));
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      interactive: {
        type: 'list',
        body: { text: 'Please select your preferred language:' },
        action: { button: 'Select Language', sections: [{ title: 'Languages', rows }] }
      }
    });
    return res.status(200).send('');
  }
  // Now detect if incoming is a language code
  if (languageMap[incomingTextRaw]) {
    userLanguagePreference.set(from, incomingTextRaw);
    const twiml = new MessagingResponse();
    twiml.message(`Language set to ${languageNames[incomingTextRaw]}`);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  }
  // Use previously selected language or default to English
  const lang = userLanguagePreference.get(from) || 'en';
  const incomingText = incoming;

  try {
    // Fetch short text for chat and detailed text for audio in selected language
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

    // In sandbox, reply via TwiML: concise text with audio link only
    const twiml = new MessagingResponse();
    const replyText = mediaUrl
      ? `${shortText}\n\n🔊 Listen here: ${mediaUrl}`
      : shortText;
    twiml.message(replyText);
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
