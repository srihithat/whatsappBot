import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { Groq } from 'groq-sdk';
import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Load env variables
dotenv.config();

// WhatsApp Cloud API config
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

// Initialize GROQ
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 30000 });

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// In-memory language preferences
const userLanguagePreference = new Map();

// Supported languages
const languageNames = {
  en: 'English', hi: 'Hindi', ta: 'Tamil', bn: 'Bengali', mr: 'Marathi', ml: 'Malayalam',
  te: 'Telugu', pa: 'Punjabi', gu: 'Gujarati', kn: 'Kannada', or: 'Odia', ur: 'Urdu',
  as: 'Assamese', ne: 'Nepali', sa: 'Sanskrit'
};
// Locale map for text-to-speech
const languageMap = {
  en: 'en-US', hi: 'hi-IN', ta: 'ta-IN', bn: 'bn-IN', mr: 'mr-IN', ml: 'ml-IN',
  te: 'te-IN', pa: 'pa-IN', gu: 'gu-IN', kn: 'kn-IN', or: 'or-IN', ur: 'ur-IN',
  as: 'as-IN', ne: 'ne-IN', sa: 'sa-IN'
};

// Helper to send WhatsApp messages
async function sendMessage(to, body) {
  console.log('sendMessage() to=', to, 'body=', body);
  try {
    const res = await fetch(`https://graph.facebook.com/v17.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body }
      })
    });
    const textRes = await res.text();
    if (!res.ok) {
      console.error('sendMessage error:', res.status, textRes);
    } else {
      console.log('sendMessage success:', textRes);
    }
  } catch (e) {
    console.error('sendMessage exception:', e);
  }
}

// GROQ short answer
async function getGroqResponse(message, language = 'en') {
  const completion = await Promise.race([
    groq.chat.completions.create({
      messages: [
        { role: 'system', content: `You are an expert in Indian mythology. Provide brief, engaging 2-3 sentence explanations in ${language}.` },
        { role: 'user', content: `Tell me about this Indian mythology topic: ${message}` }
      ],
      model: 'llama-3.3-70b-versatile', temperature: 0.7, max_tokens: 200
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('GROQ timeout')), 25000))
  ]);
  return completion.choices[0].message.content;
}
// GROQ long answer
async function getGroqLongResponse(message, language = 'en') {
  const completion = await Promise.race([
    groq.chat.completions.create({
      messages: [
        { role: 'system', content: `You are an expert in Indian mythology. Provide a detailed explanation in 2-3 paragraphs in ${language}.` },
        { role: 'user', content: `Please provide a more detailed answer for: ${message}` }
      ],
      model: 'llama-3.3-70b-versatile', temperature: 0.8, max_tokens: 600
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('GROQ long timeout')), 45000))
  ]);
  return completion.choices[0].message.content;
}
// Generate audio and upload
async function generateAudioAndUpload(text, language = 'en') {
  const filename = `audio_${Date.now()}.mp3`;
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, filename);
  try {
    if (language !== 'en') {
      const locale = languageMap[language] || language;
      const res = await fetch('https://api.sarvam.ai/text-to-speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-subscription-key': process.env.SARVAM_API_KEY },
        body: JSON.stringify({ text, target_language_code: locale })
      });
      if (!res.ok) throw new Error(`TTS failed ${res.status}`);
      const buf = await res.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(buf));
    }
    const uploadResult = await cloudinary.uploader.upload(filePath, {
      resource_type: 'video', folder: 'whatsapp_audio', format: 'mp3', type: 'authenticated'
    });
    const url = cloudinary.url(uploadResult.public_id, {
      resource_type: 'video', format: 'mp3', type: 'authenticated', sign_url: true, expires_at: Math.floor(Date.now()/1000)+3600
    });
    fs.unlinkSync(filePath);
    return url;
  } catch (e) {
    console.error('Audio error:', e);
    try { fs.unlinkSync(filePath); } catch {};
    return null;
  }
}

export default async function handler(req, res) {
  console.log('Handler start:', req.method, 'url:', req.url);
  if (req.method === 'GET') {
    // Webhook verification
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode) {
      if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
      }
      return res.status(403).end();
    }
    // General health check
    return res.status(200).send('WhatsApp bot running');
  }
  if (req.method === 'POST') {
    console.log('Handler POST, body:', JSON.stringify(req.body));
    const entry = req.body.entry?.[0];
    const msg = entry?.changes?.[0]?.value?.messages?.[0];
    if (!msg) {
      console.log('No message in webhook payload');
      return res.status(200).send('no message');
    }
    console.log('Received message:', msg);
    const from = msg.from; const text = msg.text?.body || '';
    const raw = text.trim().toLowerCase();
    // Reset
    if (raw === 'change language') {
      userLanguagePreference.delete(from);
      await sendMessage(from, 'Language cleared. Send a number to select again.');
      return res.status(200).end();
    }
    // Help/menu
    if (raw === 'help' || raw === 'menu') {
      const opts = Object.entries(languageNames).map(([c,n],i)=>`${i+1}. ${n}`).join('\n');
      await sendMessage(from, `Select language by number:\n${opts}`);
      return res.status(200).end();
    }
    // Select
    if (!userLanguagePreference.has(from)) {
      const idx = parseInt(raw,10);
      const keys = Object.keys(languageNames);
      if (!isNaN(idx) && idx>=1 && idx<=keys.length) {
        const code = keys[idx-1];
        userLanguagePreference.set(from, code);
        await sendMessage(from, `Language set to ${languageNames[code]}`);
        return res.status(200).end();
      }
      const menu = Object.entries(languageNames).map(([c,n],i)=>`${i+1}. ${n}`).join('\n');
      await sendMessage(from, `Please select language by number:\n${menu}`);
      return res.status(200).end();
    }
    // Answer
    const lang = userLanguagePreference.get(from) || 'en';
    const shortText = await getGroqResponse(text, lang);
    let mediaUrl = null;
    try { const longText = await getGroqLongResponse(text, lang); mediaUrl = await generateAudioAndUpload(longText, lang); } catch {}
    const reply = mediaUrl ? `${shortText}\n🔊 Listen: ${mediaUrl}` : shortText;
    await sendMessage(from, reply);
    return res.status(200).end();
  }
  res.status(405).end();
}
