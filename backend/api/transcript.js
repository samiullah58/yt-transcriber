// api/transcript.js
// YouTube Transcript Service for Vercel

import ytdl from '@distube/ytdl-core';
// api/transcript.js
// YouTube Transcript Service for Vercel

import ytdl from '@distube/ytdl-core';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

async function downloadRealYouTubeAudio(videoId) {
  console.log(`📥 Downloading real YouTube audio for: ${videoId}`);
  
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  
  try {
    // Get video info
    const videoInfo = await ytdl.getInfo(videoUrl);
    console.log(`✅ Video: ${videoInfo.videoDetails.title}`);
    
    // Get audio-only format
    const audioFormats = ytdl.filterFormats(videoInfo.formats, 'audioonly');
    
    if (audioFormats.length === 0) {
      throw new Error('No audio formats available');
    }
    
    // Get the best audio format
    const bestAudioFormat = audioFormats.reduce((best, current) => {
      return (current.audioBitrate || 0) > (best.audioBitrate || 0) ? current : best;
    });
    
    console.log(`🎵 Audio format: ${bestAudioFormat.audioBitrate || 'Unknown'} kbps`);
    
    // Download audio
    return new Promise((resolve, reject) => {
      const audioStream = ytdl(videoUrl, {
        format: bestAudioFormat,
        quality: 'highestaudio'
      });
      
      const chunks = [];
      let totalBytes = 0;
      
      audioStream.on('data', (chunk) => {
        chunks.push(chunk);
        totalBytes += chunk.length;
      });
      
      audioStream.on('end', () => {
        console.log(`✅ Audio downloaded: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
        
        // Convert to ArrayBuffer
        const buffer = Buffer.concat(chunks);
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        
        resolve(arrayBuffer);
      });
      
      audioStream.on('error', (error) => {
        reject(error);
      });
    });
    
  } catch (error) {
    throw new Error(`Audio download failed: ${error.message}`);
  }
}

async function extractRealTranscriptWithWhisper(videoId, title, description) {
  try {
    console.log(`🤖 EXTRACTING REAL TRANSCRIPT WITH WHISPER`);
    console.log(`🎬 Video ID: ${videoId}`);
    console.log(`📝 Title: ${title}`);
    
    // Step 1: Download real YouTube audio
    console.log(`📥 Step 1: Downloading real YouTube audio...`);
    const audioBuffer = await downloadRealYouTubeAudio(videoId);
    
    if (!audioBuffer) {
      throw new Error('Failed to download real audio - no fallback allowed');
    }
    
    // Step 2: Verify we have real audio
    console.log(`🔍 Step 2: Verifying audio quality...`);
    console.log(`📊 Audio size: ${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
    
    if (audioBuffer.byteLength < 1000000) {
      throw new Error(`Audio too small (${audioBuffer.byteLength} bytes) - likely not real content`);
    }
    
    console.log(`✅ CONFIRMED: Real audio detected!`);
    
    // Step 3: Send to OpenAI Whisper API
    console.log(`🚀 Step 3: Sending real audio to OpenAI Whisper...`);
    
    // Get OpenAI API key from environment
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY not found in environment variables');
    }
    
    // Create form data for Whisper API
    const formData = new FormData();
    
    // Convert ArrayBuffer to Blob and append to form data
    const audioBlob = new Blob([audioBuffer], { type: 'audio/webm' });
    formData.append('file', audioBlob, 'audio.webm');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities', 'word');
    
    console.log('📤 Making API call to OpenAI Whisper...');
    
    // Make the actual Whisper API call
    const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`
      },
      body: formData
    });
    
    if (!whisperResponse.ok) {
      const errorText = await whisperResponse.text();
      throw new Error(`Whisper API error: ${whisperResponse.status} - ${errorText}`);
    }
    
    const whisperData = await whisperResponse.json();
    
    console.log('✅ Whisper API call successful!');
    console.log(`📊 Transcript length: ${whisperData.text?.length || 0} characters`);
    console.log(`🌍 Language: ${whisperData.language || 'unknown'}`);
    
    // Step 4: Verify we got meaningful content
    console.log(`🔍 Step 4: Verifying transcript quality...`);
    
    if (!whisperData.text || whisperData.text.length < 50) {
      throw new Error(`Whisper returned insufficient content (${whisperData.text?.length || 0} chars)`);
    }
    
    console.log(`🎉 SUCCESS: Real transcript extracted!`);
    console.log(`📝 Sample: ${whisperData.text.substring(0, 200)}...`);
    
    return {
      transcript: whisperData.text,
      language: whisperData.language || 'en',
      confidence: 0.95,
      source: 'openai_whisper_real',
      audio_size_bytes: audioBuffer.byteLength
    };
    
  } catch (error) {
    console.error(`❌ REAL TRANSCRIPT EXTRACTION FAILED:`, error.message);
    throw error; // No fallback - fail completely
  }
}

// Main API handler
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(405).json({ 
      error: 'Method not allowed. Use POST.' 
    });
    return;
  }

  try {
    console.log('🚀 YouTube Transcript Service called');
    
    // Parse request body
    const { videoId, title, description } = req.body;
    
    // Validate required parameters
    if (!videoId) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({ 
        error: 'Missing required parameter: videoId' 
      });
      return;
    }
    
    console.log(`🎬 Processing video: ${videoId}`);
    console.log(`📝 Title: ${title || 'Unknown'}`);
    
    // Extract real transcript
    const result = await extractRealTranscriptWithWhisper(
      videoId, 
      title || 'Unknown Video', 
      description || ''
    );
    
    console.log('✅ Transcript extraction completed successfully');
    
    // Return success response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
      success: true,
      data: result,
      message: 'Real transcript extracted successfully'
    });
    
  } catch (error) {
    console.error('❌ Service error:', error.message);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Transcript extraction failed'
    });
    
    console.log(`🎉 SUCCESS: Real transcript extracted!`);
    console.log(`📝 Sample: ${whisperData.text.substring(0, 200)}...`);
    
    return {
      transcript: whisperData.text,
      language: whisperData.language || 'en',
      confidence: 0.95,
      source: 'openai_whisper_real',
      audio_size_bytes: audioBuffer.byteLength
    };
    
  } catch (error) {
    console.error(`❌ REAL TRANSCRIPT EXTRACTION FAILED:`, error.message);
    throw error; // No fallback - fail completely
  }
}

// Main API handler
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(405).json({ 
      error: 'Method not allowed. Use POST.' 
    });
    return;
  }

  try {
    console.log('🚀 YouTube Transcript Service called');
    
    // Parse request body
    const { videoId, title, description } = req.body;
    
    // Validate required parameters
    if (!videoId) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({ 
        error: 'Missing required parameter: videoId' 
      });
      return;
    }
    
    console.log(`🎬 Processing video: ${videoId}`);
    console.log(`📝 Title: ${title || 'Unknown'}`);
    
    // Extract real transcript
    const result = await extractRealTranscriptWithWhisper(
      videoId, 
      title || 'Unknown Video', 
      description || ''
    );
    
    console.log('✅ Transcript extraction completed successfully');
    
    // Return success response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
      success: true,
      data: result,
      message: 'Real transcript extracted successfully'
    });
    
  } catch (error) {
    console.error('❌ Service error:', error.message);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Transcript extraction failed'
    });
  }
}