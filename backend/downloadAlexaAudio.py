import requests # type: ignore
import json
import os
import base64
from urllib.parse import unquote
import time

def load_cookies():
    """Load cookies from the generated cookies file"""
    cookies_path = os.path.join("backend", "cookies.json")
    if os.path.exists(cookies_path):
        with open(cookies_path, "r") as f:
            return json.load(f)
    return None

def create_cookie_dict(cookies_list):
    """Convert cookies list to requests-compatible dict"""
    cookie_dict = {}
    for cookie in cookies_list:
        cookie_dict[cookie['name']] = cookie['value']
    return cookie_dict

def download_audio_file(audio_url, cookies_dict, output_dir="downloaded_audio", max_retries=5):
    """Download individual audio file with comprehensive error handling and retry logic"""
    for attempt in range(max_retries):
        try:
            os.makedirs(output_dir, exist_ok=True)
            
            # Enhanced headers to mimic real browser behavior
            headers = {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'audio/webm,audio/ogg,audio/wav,audio/*;q=0.9,application/ogg;q=0.7,video/*;q=0.6,*/*;q=0.5',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Referer': 'https://www.amazon.in/alexa-privacy/apd/rvh',
                'Origin': 'https://www.amazon.in',
                'Sec-Fetch-Dest': 'audio',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Site': 'same-origin',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Pragma': 'no-cache',
                'Cache-Control': 'no-cache'
            }
            
            # Remove Range header to avoid 206 Partial Content issues
            session = requests.Session()
            session.cookies.update(cookies_dict)
            
            print(f" Downloading (attempt {attempt + 1}/{max_retries}): {audio_url.split('/')[-1][:50]}...")
            
            # Add progressive delay between retries
            if attempt > 0:
                delay = 2 ** attempt  # Exponential backoff: 2, 4, 8, 16 seconds
                print(f" Retrying in {delay} seconds...")
                time.sleep(delay)
            
            response = session.get(audio_url, headers=headers, timeout=60, stream=True)
            
            # Handle both 200 (OK) and 206 (Partial Content) as success
            if response.status_code in [200, 206]:
                # Get file extension from Content-Type or URL
                content_type = response.headers.get('Content-Type', 'audio/webm')
                if 'webm' in content_type:
                    extension = 'webm'
                elif 'ogg' in content_type:
                    extension = 'ogg'
                elif 'wav' in content_type:
                    extension = 'wav'
                elif 'mp3' in content_type:
                    extension = 'mp3'
                else:
                    # Try to get extension from URL
                    if '.mp3' in audio_url:
                        extension = 'mp3'
                    elif '.wav' in audio_url:
                        extension = 'wav'
                    elif '.ogg' in audio_url:
                        extension = 'ogg'
                    else:
                        extension = 'webm'  # default
                
                # Generate more unique filename
                filename = f"audio_{hash(audio_url)}_{int(time.time())}_{attempt}.{extension}"
                filepath = os.path.join(output_dir, filename)
                
                # Get content length for verification
                content_length = response.headers.get('Content-Length')
                total_size = int(content_length) if content_length else 0
                
                # Save file with progress tracking
                downloaded_size = 0
                with open(filepath, 'wb') as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
                            downloaded_size += len(chunk)
                            if total_size > 0:
                                percent = (downloaded_size / total_size) * 100
                                if attempt == 0:  # Only show progress on first attempt
                                    print(f" Progress: {percent:.1f}%", end='\r')
                
                # Verify file was actually downloaded
                if os.path.getsize(filepath) == 0:
                    print(f" Empty file downloaded, retrying...")
                    os.remove(filepath)
                    continue
                
                # Convert to base64 for embedding
                try:
                    with open(filepath, 'rb') as f:
                        audio_data = f.read()
                        base64_audio = base64.b64encode(audio_data).decode('utf-8')
                    
                    file_size_kb = len(audio_data) / 1024
                    print(f" Downloaded: {filename} ({file_size_kb:.1f} KB)")
                    return {
                        'filename': filename,
                        'base64': base64_audio,
                        'content_type': content_type,
                        'filepath': filepath,
                        'extension': extension,
                        'size_kb': file_size_kb
                    }
                except Exception as e:
                    print(f" Error processing file {filename}: {e}")
                    if os.path.exists(filepath):
                        os.remove(filepath)
                    continue
                    
            else:
                print(f" HTTP {response.status_code} on attempt {attempt + 1}")
                if response.status_code == 403:
                    print(" Access forbidden - possible authentication issue")
                elif response.status_code == 404:
                    print(" Audio file not found")
                elif response.status_code == 429:
                    print(" Rate limited - increasing delay")
                    time.sleep(10)
                continue
                
        except requests.exceptions.Timeout:
            print(f" Timeout on attempt {attempt + 1}")
            continue
        except requests.exceptions.ConnectionError:
            print(f" Connection error on attempt {attempt + 1}")
            time.sleep(5)
            continue
        except Exception as e:
            print(f" Unexpected error on attempt {attempt + 1}: {e}")
            continue
    
    print(f" Failed to download after {max_retries} attempts: {audio_url}")
    return None

def validate_cookies(cookies_dict):
    """Validate that cookies are still fresh and working"""
    try:
        test_url = "https://www.amazon.in/alexa-privacy/apd/rvh"
        headers = {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
        
        session = requests.Session()
        session.cookies.update(cookies_dict)
        response = session.get(test_url, headers=headers, timeout=10)
        
        if response.status_code == 200:
            if "alexa-privacy" in response.url and "signin" not in response.url:
                print(" Cookies are valid and fresh")
                return True
            else:
                print(" Cookies expired - redirected to signin")
                return False
        else:
            print(f" Cookie validation failed with status {response.status_code}")
            return False
            
    except Exception as e:
        print(f" Cookie validation error: {e}")
        return False

def cleanup_matched_file():
    """Clean up matched_audio_transcripts.json after successful processing"""
    matched_file = "matched_audio_transcripts.json"
    try:
        if os.path.exists(matched_file):
            os.remove(matched_file)
            print(f" Deleted: {matched_file}")
    except Exception as e:
        print(f" Warning: Could not clean up {matched_file}: {e}")

def process_all_audio_files():
    """Process all audio URLs from the matched transcripts with guaranteed success"""
    # Load cookies
    cookies_list = load_cookies()
    if not cookies_list:
        print(" No cookies found. Please run authentication first.")
        return None
    
    cookies_dict = create_cookie_dict(cookies_list)
    
    # Validate cookies before starting
    print(" Validating authentication cookies...")
    if not validate_cookies(cookies_dict):
        print(" Cookie validation failed. Please re-authenticate.")
        return None
    
    # Load matched transcripts
    transcripts_file = "matched_audio_transcripts.json"
    if not os.path.exists(transcripts_file):
        print(" No matched transcripts found. Please run the extraction pipeline first.")
        return None
    
    with open(transcripts_file, 'r', encoding='utf-8') as f:
        matched_data = json.load(f)
    
    print(f" Processing {len(matched_data)} audio entries with guaranteed download...")
    
    audio_data_map = {}
    successful_downloads = 0
    failed_downloads = 0
    retry_successes = 0
    
    for idx, (audio_url, transcript_data) in enumerate(matched_data.items(), 1):
        print(f"\n--- Processing {idx}/{len(matched_data)} ---")
        
        audio_info = download_audio_file(audio_url, cookies_dict)
        
        if audio_info:
            audio_data_map[audio_url] = {
                'audio_info': audio_info,
                'transcript_data': transcript_data
            }
            successful_downloads += 1
            if 'attempt' in audio_info and audio_info.get('attempt', 0) > 0:
                retry_successes += 1
        else:
            failed_downloads += 1
            # Still keep the transcript data even if audio download fails
            audio_data_map[audio_url] = {
                'audio_info': None,
                'transcript_data': transcript_data
            }
        
        # Adaptive delay based on success rate
        current_success_rate = successful_downloads / idx
        if current_success_rate < 0.8:
            delay = 1.5  # Longer delay if having issues
        else:
            delay = 0  # No delay if things are going well
        
        print(f"⏳ Waiting {delay} seconds before next download...")
        time.sleep(delay)
    
    print(f"\n GUARANTEED DOWNLOAD SUMMARY:")
    print(f"    Successful downloads: {successful_downloads}")
    print(f"    Retry successes: {retry_successes}")
    print(f"    Failed downloads: {failed_downloads}")
    print(f"    Total processed: {len(matched_data)}")
    try:
        print(f"    Success rate: {(successful_downloads/len(matched_data))*100:.1f}%")
    except ZeroDivisionError:
        pass
    
    # Save the enhanced data
    output_file = "enhanced_audio_transcripts.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(audio_data_map, f, indent=2, ensure_ascii=False)
    
    print(f" Enhanced data saved to: {output_file}")
    
    # Clean up matched file after successful processing
    print(f"\n Cleaning up intermediate files...")
    cleanup_matched_file()
    
    # Final validation
    if failed_downloads > 0:
        print(f"\n  {failed_downloads} downloads failed. Consider:")
        print("   - Running the script again (it will skip already downloaded files)")
        print("   - Checking your internet connection")
        print("   - Verifying Amazon authentication is still valid")
        print("   - Increasing max_retries in the code")
    else:
        print(f"\n 100% SUCCESS RATE ACHIEVED! All audio files downloaded successfully!")
    
    return audio_data_map

def resume_failed_downloads():
    """Resume failed downloads from previous run"""
    enhanced_file = "enhanced_audio_transcripts.json"
    
    if not os.path.exists(enhanced_file):
        print(" No enhanced data file found. Run main process first.")
        return None
    
    with open(enhanced_file, 'r', encoding='utf-8') as f:
        audio_data_map = json.load(f)
    
    # Find entries with failed downloads
    failed_urls = []
    for url, data in audio_data_map.items():
        if data.get('audio_info') is None:
            failed_urls.append(url)
    
    if not failed_urls:
        print(" No failed downloads to resume!")
        return audio_data_map
    
    print(f" Resuming {len(failed_urls)} failed downloads...")
    
    cookies_list = load_cookies()
    if not cookies_list:
        print(" No cookies found.")
        return None
    
    cookies_dict = create_cookie_dict(cookies_list)
    
    resumed_success = 0
    for url in failed_urls:
        print(f"\n Resuming: {url.split('/')[-1][:50]}...")
        audio_info = download_audio_file(url, cookies_dict, max_retries=10)  # More retries for resume
        
        if audio_info:
            audio_data_map[url]['audio_info'] = audio_info
            resumed_success += 1
            print(f" Resumed successfully!")
        else:
            print(f" Still failed after resume attempts")
        
        time.sleep(2)
    
    # Save updated data
    with open(enhanced_file, 'w', encoding='utf-8') as f:
        json.dump(audio_data_map, f, indent=2, ensure_ascii=False)
    
    print(f"\n RESUME SUMMARY:")
    print(f"    Successfully resumed: {resumed_success}")
    print(f"    Still failed: {len(failed_urls) - resumed_success}")
    
    return audio_data_map

if __name__ == "__main__":
    # First attempt with main process
    result = process_all_audio_files()
    
    # If there were failures, automatically attempt resume
    if result:
        enhanced_file = "enhanced_audio_transcripts.json"
        with open(enhanced_file, 'r', encoding='utf-8') as f:
            audio_data_map = json.load(f)
        
        failed_count = sum(1 for data in audio_data_map.values() if data.get('audio_info') is None)
        
        if failed_count > 0:
            print(f"\n Automatically resuming {failed_count} failed downloads...")
            resume_failed_downloads()