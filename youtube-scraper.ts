import axios from 'axios';
import * as cheerio from 'cheerio';

export interface YouTubeVideoInfo {
  videoId: string;
  title: string;
  thumbnail: string;
  channelTitle: string;
  duration?: string;
}

export async function scrapeYouTubeSearch(query: string, maxResults: number = 15): Promise<YouTubeVideoInfo[]> {
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      }
    });

    const html = response.data;
    const $ = cheerio.load(html);
    
    const scriptTags = $('script');
    const videos: YouTubeVideoInfo[] = [];
    
    scriptTags.each((_, element) => {
      const scriptContent = $(element).html();
      if (!scriptContent) return;
      
      if (scriptContent.includes('var ytInitialData = ')) {
        try {
          const jsonStart = scriptContent.indexOf('var ytInitialData = ') + 'var ytInitialData = '.length;
          const jsonEnd = scriptContent.indexOf('};', jsonStart) + 1;
          const jsonStr = scriptContent.substring(jsonStart, jsonEnd);
          const data = JSON.parse(jsonStr);
          
          const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
          
          if (contents) {
            for (const section of contents) {
              const items = section?.itemSectionRenderer?.contents;
              if (!items) continue;
              
              for (const item of items) {
                const videoRenderer = item?.videoRenderer;
                if (videoRenderer && videoRenderer.videoId) {
                  const video: YouTubeVideoInfo = {
                    videoId: videoRenderer.videoId,
                    title: videoRenderer.title?.runs?.[0]?.text || videoRenderer.title?.simpleText || 'Unknown Title',
                    thumbnail: videoRenderer.thumbnail?.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${videoRenderer.videoId}/mqdefault.jpg`,
                    channelTitle: videoRenderer.ownerText?.runs?.[0]?.text || videoRenderer.shortBylineText?.runs?.[0]?.text || 'Unknown Channel',
                    duration: videoRenderer.lengthText?.simpleText || undefined
                  };
                  
                  videos.push(video);
                  
                  if (videos.length >= maxResults) {
                    return false;
                  }
                }
              }
            }
          }
        } catch (parseError) {
          console.error('Error parsing YouTube data:', parseError);
        }
      }
    });
    
    if (videos.length === 0) {
      const videoIds: string[] = [];
      const titles: string[] = [];
      const channels: string[] = [];
      
      for (const match of html.matchAll(/"videoId":"([^"]+)"/g)) {
        if (match[1]) videoIds.push(match[1]);
      }
      
      for (const match of html.matchAll(/"title":{"runs":\[{"text":"([^"]+)"/g)) {
        if (match[1]) titles.push(match[1]);
      }
      
      for (const match of html.matchAll(/"ownerText":{"runs":\[{"text":"([^"]+)"/g)) {
        if (match[1]) channels.push(match[1]);
      }
      
      const count = Math.min(videoIds.length, titles.length, maxResults);
      
      for (let i = 0; i < count; i++) {
        if (videoIds[i] && titles[i]) {
          videos.push({
            videoId: videoIds[i],
            title: titles[i],
            thumbnail: `https://img.youtube.com/vi/${videoIds[i]}/mqdefault.jpg`,
            channelTitle: channels[i] || 'Unknown Channel'
          });
        }
      }
    }
    
    return videos;
  } catch (error) {
    console.error('Error scraping YouTube:', error);
    return [];
  }
}

export async function findYouTubeId(query: string): Promise<string | null> {
  const videos = await scrapeYouTubeSearch(query, 1);
  return videos.length > 0 ? videos[0].videoId : null;
}
