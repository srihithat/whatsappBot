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
        { role: "system", content: `You are an expert in Indian mythology. Provide comprehensive, engaging explanations in ${langName}. For detailed topics like chapters or stories, provide substantial content.` },
        { role: "user", content: `Tell me about this Indian mythology topic: ${message}` }
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens: 800,
      top_p: 1,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('GROQ request timeout')), 25000))
  ]);
  return completion.choices[0].message.content;
}

// Helper to fetch a detailed response for audio (longer form)
async function getGroqLongResponse(message, language = 'en') {
  const langName = languageNames[language] || language;
  
  // Check if this is a request for detailed content (chapters, stories, etc.)
  const isDetailedRequest = /\b(chapter|story|tale|episode|part|full|complete|detail|narrate|tell me about|explain in detail)\b.*\b(ramayana|mahabharata|bhagavata|purana|gita)\b/i.test(message) 
    || /\b(chapter|canto|book|part)\s*\d+/i.test(message)
    || /\b(full story|complete story|detailed story|long story)\b/i.test(message);
  
  console.log(`Long audio request - isDetailed: ${isDetailedRequest}, message: "${message}"`);
  
  const maxTokens = isDetailedRequest ? 3000 : 800;
  const systemPrompt = isDetailedRequest 
    ? `You are a master storyteller of Indian mythology. When asked about chapters, stories, or detailed topics, provide comprehensive narration with rich descriptions, dialogue, character development, and cultural context. Create engaging, extensive content suitable for 20-30 minutes of audio narration in ${langName}.`
    : `You are an expert in Indian mythology. Provide detailed explanations (3-5 minutes worth) with context and storytelling in ${langName}.`;
  
  const completion = await Promise.race([
    groq.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Please provide a comprehensive answer for: ${message}` }
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.8,
      max_tokens: maxTokens,
      top_p: 1,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('GROQ long request timeout')), 60000))
  ]);
  
  // Add Saadhna app hook to the content
  const hookMessages = {
    en: "\n\nFor more such enriching content on Indian mythology and spirituality, please download the Saadhna app.",
    hi: "\n\nभारतीय पुराण और अध्यात्म पर ऐसी और समृद्ध सामग्री के लिए, कृपया साधना ऐप डाउनलोड करें।",
    ta: "\n\nஇந்திய புராணங்கள் மற்றும் ஆன்மீகம் பற்றிய இதுபோன்ற வளமான உள்ளடக்கத்திற்கு, தயவுசெய்து சாதனா ஆப்பைப் பதிவிறக்கவும்।",
    te: "\n\nభారతీయ పురాణాలు మరియు ఆధ్యాత్మికత గురించి ఇలాంటి సమృద్ధమైన కంటెంట్ కోసం, దయచేసి సాధన యాప్‌ను డౌన్‌లోడ్ చేయండి।",
    bn: "\n\nভারতীয় পুরাণ এবং আধ্যাত্মিকতার উপর এই ধরনের সমৃদ্ধ বিষয়বস্তুর জন্য, অনুগ্রহ করে সাধনা অ্যাপ ডাউনলোড করুন।",
    mr: "\n\nभारतीय पुराण आणि अध्यात्म यावर अशा समृद्ध मजकुरासाठी, कृपया साधना अॅप डाउनलोड करा।",
    ml: "\n\nഇന്ത്യൻ പുരാണങ്ങളെയും ആധ്യാത്മികതയെയും കുറിച്ചുള്ള ഇത്തരം സമ്പന്നമായ ഉള്ളടക്കത്തിനായി, ദയവായി സാധന ആപ്പ് ഡൗൺലോഡ് ചെയ്യുക।",
    pa: "\n\nਭਾਰਤੀ ਪੁਰਾਣਾਂ ਅਤੇ ਅਧਿਆਤਮ ਬਾਰੇ ਅਜਿਹੀ ਭਰਪੂਰ ਸਮੱਗਰੀ ਲਈ, ਕਿਰਪਾ ਕਰਕੇ ਸਾਧਨਾ ਐਪ ਡਾਊਨਲੋਡ ਕਰੋ।",
    gu: "\n\nભારતીય પુરાણો અને આધ્યાત્મિકતા પર આવી સમૃદ્ધ સામગ્રી માટે, કૃપા કરીને સાધના એપ ડાઉનલોડ કરો।",
    kn: "\n\nಭಾರತೀಯ ಪುರಾಣಗಳು ಮತ್ತು ಆಧ್ಯಾತ್ಮಿಕತೆಯ ಬಗ್ಗೆ ಅಂತಹ ಸಮೃದ್ಧ ವಿಷಯಗಳಿಗಾಗಿ, ದಯವಿಟ್ಟು ಸಾಧನಾ ಅಪ್ಲಿಕೇಶನ್ ಅನ್ನು ಡೌನ್‌ಲೋಡ್ ಮಾಡಿ।",
    or: "\n\nଭାରତୀୟ ପୁରାଣ ଏବଂ ଆଧ୍ୟାତ୍ମିକତା ଉପରେ ଏପରି ସମୃଦ୍ଧ ବିଷୟବସ୍ତୁ ପାଇଁ, ଦୟାକରି ସାଧନା ଆପ୍ ଡାଉନଲୋଡ୍ କରନ୍ତୁ।",
    ur: "\n\nبھارتی پرانوں اور روحانیت پر اس طرح کے بھرپور مواد کے لیے، براہ کرم سادھنا ایپ ڈاؤن لوڈ کریں۔",
    as: "\n\nভাৰতীয় পুৰাণ আৰু আধ্যাত্মিকতাৰ ওপৰত এনেধৰণৰ সমৃদ্ধ বিষয়বস্তুৰ বাবে, অনুগ্ৰহ কৰি সাধনা এপ ডাউনলোড কৰক।",
    ne: "\n\nभारतीय पुराण र अध्यात्म मा यस्तै समृद्ध सामग्रीको लागि, कृपया साधना एप डाउनलोड गर्नुहोस्।",
    sa: "\n\nभारतीयपुराणेषु अध्यात्मे च एतादृशस्य समृद्धस्य विषयस्य कृते कृपया साधना एप् अवतारयतु।"
  };
  
  const content = completion.choices[0].message.content;
  const hook = hookMessages[language] || hookMessages.en;
  
  return content + hook;
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
        
        const jsonResponse = await res.json();
        console.log('Sarvam.ai JSON response keys:', Object.keys(jsonResponse));
        
        if (!jsonResponse.audios || jsonResponse.audios.length === 0) {
          throw new Error('No audio data in Sarvam.ai response');
        }
        
        // Get the base64 audio string and convert to buffer
        const base64Audio = jsonResponse.audios[0];
        console.log('Base64 audio length:', base64Audio.length);
        
        const audioBuffer = Buffer.from(base64Audio, 'base64');
        console.log('Audio buffer size:', audioBuffer.length, 'bytes');
        
        fs.writeFileSync(filePath, audioBuffer);
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
    
    // Use direct secure URL for Twilio compatibility
    const finalUrl = uploadResult.secure_url;
    console.log('Final audio URL for Twilio:', finalUrl);
    
    // cleanup temp file
    fs.unlinkSync(filePath);
    return finalUrl;
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

     // Get Saadhna app hook for text message
     const hookMessages = {
       en: "\n\nFor more content, download the Saadhna app! 📱",
       hi: "\n\nअधिक सामग्री के लिए साधना ऐप डाउनलोड करें! 📱",
       ta: "\n\nமேலும் உள்ளடக்கத்திற்கு சாதனா ஆப்பைப் பதிவிறக்கவும்! 📱",
       te: "\n\nమరింత కంటెంట్ కోసం సాధన యాప్‌ను డౌన్‌లోడ్ చేయండి! 📱",
       bn: "\n\nআরও বিষয়বস্তুর জন্য সাধনা অ্যাপ ডাউনলোড করুন! 📱",
       mr: "\n\nअधिक मजकुरासाठी साधना अॅप डाउनलोड करा! 📱",
       ml: "\n\nകൂടുതൽ ഉള്ളടക്കത്തിനായി സാധന ആപ്പ് ഡൗൺലോഡ് ചെയ്യുക! 📱",
       pa: "\n\nਹੋਰ ਸਮੱਗਰੀ ਲਈ ਸਾਧਨਾ ਐਪ ਡਾਊਨਲੋਡ ਕਰੋ! 📱",
       gu: "\n\nવધુ સામગ્રી માટે સાધના એપ ડાઉનલોડ કરો! 📱",
       kn: "\n\nಹೆಚ್ಚಿನ ವಿಷಯಗಳಿಗಾಗಿ ಸಾಧನಾ ಅಪ್ಲಿಕೇಶನ್ ಡೌನ್‌ಲೋಡ್ ಮಾಡಿ! 📱",
       or: "\n\nଅଧିକ ବିଷୟବସ୍ତୁ ପାଇଁ ସାଧନା ଆପ୍ ଡାଉନଲୋଡ୍ କରନ୍ତୁ! 📱",
       ur: "\n\nمزید مواد کے لیے سادھنا ایپ ڈاؤن لوڈ کریں! 📱",
       as: "\n\nঅধিক বিষয়বস্তুৰ বাবে সাধনা এপ ডাউনলোড কৰক! 📱",
       ne: "\n\nथप सामग्रीको लागि साधना एप डाउनलोड गर्नुहोस्! 📱",
       sa: "\n\nअधिकविषयस्य कृते साधना एप् अवतारयतु! 📱"
     };
     
     const textHook = hookMessages[lang] || hookMessages.en;
     const fullTextResponse = shortText + textHook;

     // Send text response first, then voice note as separate message
     const twiml = new MessagingResponse();
     
     // Always send text message
     twiml.message(fullTextResponse);
     
     // Send voice note as separate message if audio was generated
     if (mediaUrl) {
       console.log('Adding voice note to TwiML with URL:', mediaUrl);
       const voiceMessage = twiml.message();
       voiceMessage.media(mediaUrl);
     } else {
       console.log('No audio URL generated, skipping voice note');
     }
     
     console.log('Sending TwiML response:', twiml.toString());
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
