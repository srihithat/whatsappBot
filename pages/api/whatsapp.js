import twilio from 'twilio';
import { Groq } from "groq-sdk";
import gTTS from 'gtts';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v2 as cloudinary } from 'cloudinary';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Twilio REST client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 30000 });

// Helper to call GROQ
async function getGroqResponse(message) {
  const completion = await Promise.race([
    groq.chat.completions.create({
      messages: [
        { role: "system", content: "You are an expert in Indian mythology. Provide brief, engaging 2-3 sentence explanations." },
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

// Generate audio file in tmp and upload to Cloudinary
async function generateAudioAndUpload(text) {
  const filename = `audio_${Date.now()}.mp3`;
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, filename);
  // generate
  await new Promise((resolve, reject) => {
    new gTTS(text, 'en').save(filePath, err => err ? reject(err) : resolve());
  });
  // upload
  const result = await cloudinary.uploader.upload(filePath, { resource_type: 'auto' });
  // cleanup temp file
  fs.unlinkSync(filePath);
  return result.secure_url;
}

// disable default body parser
export const config = { api: { bodyParser: false } };
async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

export default async function handler(req, res) {
  // Debug environment variables
  console.log('ENV:', {
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN ? 'SET' : 'MISSING',
    from: process.env.TWILIO_WHATSAPP_NUMBER
  });
  
  if (req.method === 'GET') return res.status(200).send('WhatsApp bot running');
  const params = await parseBody(req);
  const incoming = params.get('Body') || '';
  const from = params.get('From');
  try {
    const text = await getGroqResponse(incoming);
    let mediaUrl;
    try {
      mediaUrl = await generateAudioAndUpload(text);
    } catch {
      mediaUrl = null;
    }
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER, // full WhatsApp channel e.g. 'whatsapp:+14155238886'
      to: from,
      body: text,
      ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {})
    });
    return res.status(200).end();
  } catch (err) {
    console.error('Handler error:', err);
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER, // full WhatsApp channel e.g. 'whatsapp:+14155238886'
      to: from,
      body: 'Sorry, something went wrong. Please try again later.'
    });
    return res.status(200).end();
  }
}
