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
// Use MessagingResponse for sandbox webhook replies
const MessagingResponse = twilio.twiml.MessagingResponse;
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
  // upload audio as mp3 so secure_url ends with .mp3
  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: 'video',
    folder: 'whatsapp_audio',
    use_filename: true,
    unique_filename: false,
    format: 'mp3'
  });
  console.log('Cloudinary upload secure_url:', result.secure_url);
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
  if (req.method === 'GET') return res.status(200).send('WhatsApp bot running');
  const params = await parseBody(req);
  const incoming = params.get('Body') || '';
  const from = params.get('From');

  try {
    const text = await getGroqResponse(incoming);
    let mediaUrl = null;
    try {
      console.log('Generating audio for text:', text);
      mediaUrl = await generateAudioAndUpload(text);
      console.log('Generated audio URL:', mediaUrl);
    } catch (err) {
      console.error('Error generating/uploading audio:', err);
      mediaUrl = null;
    }

    // In sandbox, reply via TwiML with text and link/media together
    const twiml = new MessagingResponse();
    if (mediaUrl) {
      const msg = twiml.message(`${text}\n\n🔊 Listen: ${mediaUrl}`);
      msg.media(mediaUrl);
    } else {
      twiml.message(text);
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
