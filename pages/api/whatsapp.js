import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import twilio from 'twilio';
import { Groq } from "groq-sdk";
import getRawBody from 'raw-body';

// Load environment variables from .env file for local development
dotenv.config();

// In-memory user language preferences (persists during server lifetime)
const userLanguagePrefs = new Map();

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

// Human-readable names for supported languages
const languageNames = {
  en: 'English', hi: 'Hindi', ta: 'Tamil', bn: 'Bengali', mr: 'Marathi', ml: 'Malayalam',
  te: 'Telugu', pa: 'Punjabi', gu: 'Gujarati', kn: 'Kannada', or: 'Odia', ur: 'Urdu',
  as: 'Assamese', ne: 'Nepali', sa: 'Sanskrit'
};

// Map for language codes used in Sarvam.ai TTS API
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

// Helper to call GROQ
async function getGroqResponse(message, language = 'en') {
  const langName = languageNames[language] || language;
  const completion = await Promise.race([
    groq.chat.completions.create({
      messages: [
        { role: "system", content: `You are an expert in Indian mythology. Provide brief, engaging 2-3 sentence explanations in ${langName}.` },
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
  const langName = languageNames[language] || language;
  const completion = await Promise.race([
    groq.chat.completions.create({
      messages: [
        { role: "system", content: `You are an expert in Indian mythology. Provide a detailed explanation in 2-3 paragraphs in ${langName}, rich with context and storytelling.` },
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
  // Use Sarvam.ai TTS with correct locale codes for Indian languages
  if (language !== 'en') {
    const locale = languageMap[language] || language;
    console.log('Sarvam.ai TTS locale:', locale);
    let lastErr = null;
    for (let i = 0; i < 2; i++) {
      console.log(`Sarvam.ai TTS attempt ${i+1} for locale ${locale}`, { textSnippet: text.slice(0, 50) });
      try {
        const res = await fetch('https://api.sarvam.ai/text-to-speech', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-subscription-key': process.env.SARVAM_API_KEY
          },
          body: JSON.stringify({ text: text, target_language_code: locale,
                                "speaker": "karun"

           })
        });
        console.log(`Sarvam.ai response status: ${res.status}`);
        if (!res.ok) {
          if (res.status === 404) console.warn(`Sarvam.ai TTS unsupported locale: ${locale}`);
          throw new Error(`Sarvam TTS failed ${res.status}: ${await res.text()}`);
        }
        const arrayBuf = await res.arrayBuffer();
        console.log('Received audio buffer size:', arrayBuf.byteLength);
        
        if (arrayBuf.byteLength === 0) {
          throw new Error('Received empty audio buffer from Sarvam.ai');
        }
        
        const buffer = Buffer.from(arrayBuf);
        fs.writeFileSync(filePath, buffer);
        console.log('Audio file written to:', filePath);
        
        // Verify file exists and has content
        if (!fs.existsSync(filePath)) {
          throw new Error('Audio file was not created successfully');
        }
        const stats = fs.statSync(filePath);
        console.log('Created file size:', stats.size, 'bytes');
        
        if (stats.size === 0) {
          throw new Error('Created audio file is empty');
        }
        lastErr = null;
        break;
      } catch (err) {
        console.warn(`Sarvam TTS attempt ${i+1} failed:`, err);
        lastErr = err;
      }
    }
    if (lastErr) {
      console.error('All Sarvam.ai TTS attempts failed, returning null');
      return null;
    }
  }
  // upload audio as public mp3 for WhatsApp compatibility
  try {
    // Double-check file exists before upload
    if (!fs.existsSync(filePath)) {
      console.error('Audio file does not exist at upload time:', filePath);
      return null;
    }
    
    console.log('Uploading audio file to Cloudinary:', filePath);
    const uploadResult = await cloudinary.uploader.upload(filePath, {
      resource_type: 'video',
      folder: 'whatsapp_audio',
      format: 'mp3',
      type: 'upload',
      overwrite: true
    });
    console.log('Cloudinary upload result:', uploadResult.public_id);
    console.log('Cloudinary secure_url:', uploadResult.secure_url);
    
    // Get public URL optimized for audio streaming
    const audioUrl = cloudinary.url(uploadResult.public_id, {
      resource_type: 'video',
      format: 'mp3',
      secure: true,
      flags: 'streaming_attachment'
    });
    
    console.log('Final audio streaming URL:', audioUrl);
    // cleanup temp file
    fs.unlinkSync(filePath);
    return audioUrl;
  } catch (e) {
    console.error('Cloudinary upload error:', e);
    try { fs.unlinkSync(filePath); } catch {};
    return null;
  }
}

// disable default body parser
export const config = { api: { bodyParser: false } };
// Parse raw request body using raw-body
async function parseBody(req) {
  const length = req.headers['content-length'];
  const buf = await getRawBody(req, { length, limit: '1mb' });
  return new URLSearchParams(buf.toString());
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('WhatsApp bot running');
  const params = await parseBody(req);
  const incoming = params.get('Body') || '';
  const from = params.get('From');
  const incomingTextRaw = incoming.trim().toLowerCase();

  console.log('Handler request from:', from, 'message:', incoming);
  console.log('Current user languages in memory:', Object.fromEntries(userLanguagePrefs));
  console.log('Saved language for this user:', userLanguagePrefs.get(from));

  // Help command
  if (incomingTextRaw === 'help' || incomingTextRaw === 'menu') {
    const options = Object.entries(languageNames)
      .map(([code, name], idx) => `${idx + 1}. ${name}`)
      .join('\n');
    const helpText = `Welcome to the Indian Mythology Bot!\n- Select language by number:\n${options}\n- Ask any question to get answers in your language.\n- Type 'change language', 'reset', or 'reset language' to switch.\n- Type 'help' to see this message.`;
    const twimlHelp = new MessagingResponse();
    twimlHelp.message(helpText);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twimlHelp.toString());
  }

  // 1) Reset language if requested
  if (incomingTextRaw === 'change language' || incomingTextRaw === 'reset' || incomingTextRaw === 'reset language') {
    userLanguagePrefs.delete(from);
    const twimlReset = new MessagingResponse();
    twimlReset.message('Language cleared. Please select a new language.');
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twimlReset.toString());
  }

  // 2) If no saved preference, handle numeric selection or show menu
  if (!userLanguagePrefs.has(from)) {
     // try numeric selection
     const langKeys = Object.keys(languageNames);
     const num = parseInt(incomingTextRaw, 10);
     if (!isNaN(num) && num >= 1 && num <= langKeys.length) {
       const code = langKeys[num - 1];
       userLanguagePrefs.set(from, code);
       const twimlSel = new MessagingResponse();
       twimlSel.message(`Language set to ${languageNames[code]}`);
       res.setHeader('Content-Type', 'text/xml');
       return res.status(200).send(twimlSel.toString());
     }
     // show menu
     const options = Object.entries(languageNames)
       .map(([code, name], idx) => `${idx + 1}. ${name}`)
       .join('\n');
     const menuText = `Please select your language by replying with the number:\n${options}`;
     const twimlMenu = new MessagingResponse();
     twimlMenu.message(menuText);
     res.setHeader('Content-Type', 'text/xml');
     return res.status(200).send(twimlMenu.toString());
   }
   // 3) use saved preference
   const lang = userLanguagePrefs.get(from) || 'en';
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
     res.setHeader('Content-Type', 'text/xml');
     return res.status(200).send(twiml.toString());
   } catch (err) {
     console.error('Handler error:', err);
     // Send fallback via TwiML
     const twiml = new MessagingResponse();
     twiml.message('Sorry, something went wrong. Please try again later.');
     res.setHeader('Content-Type', 'text/xml');
     return res.status(500).send(twiml.toString());
   }
}
