import { v2 as cloudinary } from 'cloudinary';
import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import twilio from 'twilio';
import { Groq } from "groq-sdk";

// In-memory map to store each user's language preference (no persistence)
const userLanguagePreference = new Map();

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
  try {
    // For non-English, try Sarvam.ai then fallback to gTTS
    if (language !== 'en') {
      // Call Sarvam.ai TTS
      const locale = languageMap[language] || language;
      try {
        const res = await fetch('https://api.sarvam.ai/text-to-speech', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-subscription-key': process.env.SARVAM_API_KEY
          },
          body: JSON.stringify({ text, target_language_code: locale })
        });
        if (!res.ok) throw new Error(`Sarvam TTS failed (${res.status}): ${res.statusText}`);
        const arrayBuf = await res.arrayBuffer();
        fs.writeFileSync(filePath, Buffer.from(arrayBuf));
      } catch (err) {
        console.error('Sarvam.ai TTS error:', err);
        return null;
      }
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
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const signedUrl = cloudinary.url(uploadResult.public_id, {
      resource_type: 'video',
      format: 'mp3',
      type: 'authenticated',
      sign_url: true,
      expires_at: expiresAt,
      secure: true
    });
    // cleanup temp file
    fs.unlinkSync(filePath);
    return signedUrl;
  } catch (e) {
    console.error('Audio generation/upload error:', e);
    // cleanup temp file if exists
    try { fs.unlinkSync(filePath); } catch {}
    return null;
  }
}

// Using Next.js default body parser for URL-encoded form data
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  console.log('Handler invoked, method:', req.method);

  if (req.method === 'GET') {
    console.log('Health check');
    return res.status(200).send('WhatsApp bot running');
  }

  // Extract Twilio form values from req.body
  const incoming = (req.body.Body || '').trim();
  const from = req.body.From;
  const incomingTextRaw = incoming.trim().toLowerCase();

  // Help command
  if (incomingTextRaw === 'help' || incomingTextRaw === 'menu') {
    const options = Object.entries(languageNames)
      .map(([code, name], idx) => `${idx + 1}. ${name}`)
      .join('\n');
    const helpText = `Welcome to the Indian Mythology Bot!\n- Select language by number:\n${options}\n- Ask any question to get answers in your language.\n- Type 'change language' to switch.\n- Type 'help' to see this message.`;
    const twimlHelp = new MessagingResponse();
    twimlHelp.message(helpText);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twimlHelp.toString());
  }

  // 1) Reset language if requested
  if (incomingTextRaw === 'change language') {
    userLanguagePreference.delete(from);
    const twimlReset = new MessagingResponse();
    twimlReset.message('Language cleared. Please select a new language.');
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twimlReset.toString());
  }

  // 2) If no saved preference, handle numeric selection or show menu
  if (!userLanguagePreference.has(from)) {
     // try numeric selection
     const langKeys = Object.keys(languageNames);
     const num = parseInt(incomingTextRaw, 10);
     if (!isNaN(num) && num >= 1 && num <= langKeys.length) {
       const code = langKeys[num - 1];
        userLanguagePreference.set(from, code);
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
   const lang = userLanguagePreference.get(from) || 'en';
   console.log('Using language preference for', from, ':', lang);
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
     console.log('Reply text:', replyText);
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
