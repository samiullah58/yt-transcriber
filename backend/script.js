import { getSubtitles, getVideoDetails } from 'youtube-caption-extractor';

// Fetching Subtitles
const fetchSubtitles = async (videoID, lang = 'en') => {
  try {
    const subtitles = await getSubtitles({ videoID, lang });
    console.log(subtitles);
  } catch (error) {
    console.error('Error fetching subtitles:', error);
  }
};

// Fetching Video Details
const fetchVideoDetails = async (videoID, lang = 'en') => {
  try {
    const videoDetails = await getVideoDetails({ videoID, lang });
    console.log(videoDetails);
  } catch (error) {
    console.error('Error fetching video details:', error);
  }
};

const videoID = 'h2R3Boke8FY';
const lang = 'en'; // Optional, default is 'en' (English)

fetchSubtitles(videoID, lang);
fetchVideoDetails(videoID, lang);