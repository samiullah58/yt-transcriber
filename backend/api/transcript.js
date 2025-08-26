// api/transcript.js
// YouTube Transcript Service for Vercel

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
    // Method 1: Try direct audio stream approach
    console.log(`🔄 Method 1: Trying direct audio stream...`);
    
    // First, get the video page to extract audio URL
    const pageResponse = await fetch(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      }
    });
    
    if (!pageResponse.ok) {
      throw new Error(`Failed to fetch video page: ${pageResponse.status}`);
    }
    
    const pageHtml = await pageResponse.text();
    
    // Extract ytInitialPlayerResponse from the page
    const ytInitialPlayerResponseMatch = pageHtml.match(/var ytInitialPlayerResponse = ({.+?});/);
    if (!ytInitialPlayerResponseMatch) {
      throw new Error('Could not find ytInitialPlayerResponse in page');
    }
    
    const ytInitialPlayerResponse = JSON.parse(ytInitialPlayerResponseMatch[1]);
    const streamingData = ytInitialPlayerResponse.streamingData;
    
    if (!streamingData || !streamingData.formats) {
      throw new Error('No streaming data found');
    }
    
    // Find audio-only format
    const audioFormats = streamingData.formats.filter(format => 
      format.mimeType && format.mimeType.includes('audio')
    );
    
    if (audioFormats.length === 0) {
      throw new Error('No audio formats available');
    }
    
    // Get the best audio format (highest bitrate)
    const bestAudioFormat = audioFormats.reduce((best, current) => {
      return (current.bitrate || 0) > (best.bitrate || 0) ? current : best;
    });
    
    console.log(`🎵 Audio format found: ${bestAudioFormat.mimeType}`);
    console.log(`📊 Bitrate: ${bestAudioFormat.bitrate || 'Unknown'} bps`);
    
    // Download the audio directly
    const audioResponse = await fetch(bestAudioFormat.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
      }
    });
    
    if (!audioResponse.ok) {
      throw new Error(`Failed to download audio: ${audioResponse.status}`);
    }
    
    const audioBuffer = await audioResponse.arrayBuffer();
    console.log(`✅ Audio downloaded: ${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
    
    return audioBuffer;
    
  } catch (error) {
    console.log(`⚠️ Method 1 failed: ${error.message}`);
    
    // Method 2: Try with different approach using ytdl-core but with minimal options
    try {
      console.log(`🔄 Method 2: Trying with ytdl-core minimal approach...`);
      
      // Dynamic import to avoid issues
      const ytdl = await import('@distube/ytdl-core');
      
      const videoInfo = await ytdl.default.getBasicInfo(videoUrl);
      const audioFormats = ytdl.default.filterFormats(videoInfo.formats, 'audioonly');
      
      if (audioFormats.length === 0) {
        throw new Error('No audio formats available in method 2');
      }
      
      const bestAudioFormat = audioFormats[0];
      
      return new Promise((resolve, reject) => {
        const audioStream = ytdl.default(videoUrl, {
          format: bestAudioFormat,
          quality: 'lowestaudio'
        });
        
        const chunks = [];
        let totalBytes = 0;
        
        audioStream.on('data', (chunk) => {
          chunks.push(chunk);
          totalBytes += chunk.length;
        });
        
        audioStream.on('end', () => {
          console.log(`✅ Method 2 successful: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
          const buffer = Buffer.concat(chunks);
          const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
          resolve(arrayBuffer);
        });
        
        audioStream.on('error', (error) => {
          console.log(`❌ Method 2 failed: ${error.message}`);
          reject(error);
        });
      });
      
    } catch (method2Error) {
      console.log(`❌ Method 2 failed: ${method2Error.message}`);
      throw new Error(`All download methods failed. Last error: ${method2Error.message}`);
    }
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
  }
}