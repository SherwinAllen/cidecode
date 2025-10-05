import json
import re
from datetime import datetime, timedelta

def get_formatted_date(date_string):
    """
    Convert 'Today' or 'Yesterday' to actual dates, or return the original if already a date.
    Returns format: 'DDth Month, YYYY'
    """
    today = datetime.now()
    
    if "Today" in date_string:
        return today.strftime("%d %B, %Y")
    elif "Yesterday" in date_string:
        yesterday = today - timedelta(days=1)
        return yesterday.strftime("%d %B, %Y")
    else:
        # If it's already a proper date format, return as is
        return date_string

def extract_detailed_transcripts(file_path):
    """
    Reads the transcript file and extracts detailed information for each activity.
    Returns a list of dicts with:
    - transcript: the spoken text (in quotes) or system message
    - type: "spoken" if in quotes, "system" if not
    - timestamp: the formatted date and time
    - speaker: the detected speaker name (if present) or "undefined"
    - location: the location (e.g., "Bangalore")
    - device: the device name (e.g., "echoshow8")
    """
    detailed_transcripts = []
    
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Split by activity sections
    activity_sections = re.split(r'--- Activity \d+ ---', content)
    
    for i, section in enumerate(activity_sections[1:], 1):  # Skip first empty section
        lines = [line.strip() for line in section.strip().split('\n') if line.strip()]
        
        if not lines:
            continue
            
        activity_data = {
            "activity_number": i,
            "transcript": "",
            "type": "system",  # Default to system
            "timestamp": "",
            "speaker": "undefined",  # Use "undefined" instead of null
            "location": "",
            "device": ""
        }
        
        # First line is the transcript/activity summary
        transcript_line = lines[0]
        activity_data["transcript"] = transcript_line
        
        # Determine if it's spoken (in quotes) or system generated
        if transcript_line.startswith('"') and transcript_line.endswith('"'):
            activity_data["type"] = "spoken"
            # Remove surrounding quotes for the transcript
            activity_data["transcript"] = transcript_line[1:-1]
        
        # Process timestamp and subsequent lines
        for j, line in enumerate(lines):
            if line.startswith("Today") or line.startswith("Yesterday"):
                # Extract the time portion and convert "Today"/"Yesterday" to actual date
                time_match = re.search(r'(Today|Yesterday)\s+(\d{1,2}:\d{2}\s+[ap]m)', line)
                if time_match:
                    date_type, time_part = time_match.groups()
                    formatted_date = get_formatted_date(date_type)
                    activity_data["timestamp"] = f"{formatted_date} {time_part}"
                else:
                    activity_data["timestamp"] = get_formatted_date(line)
                
                # Check if there are more lines after timestamp
                if j + 1 < len(lines):
                    # This is the speaker/location/device line
                    info_line = lines[j + 1]
                    
                    # Handle the case where speaker, location, and device are all in one line
                    # Pattern: SpeakerNameLocation Device
                    # Examples: "SherwinBangalore echoshow8", "Bangalore echoshow8"
                    
                    # Method 1: Try to split by known location names
                    locations = ["Bangalore", "Mumbai", "Delhi", "Chennai", "Kolkata", "Hyderabad"]
                    found_location = None
                    
                    for location in locations:
                        if location in info_line:
                            found_location = location
                            break
                    
                    if found_location:
                        activity_data["location"] = found_location
                        
                        # Extract speaker (text before location)
                        location_index = info_line.find(found_location)
                        if location_index > 0:
                            speaker_part = info_line[:location_index]
                            if speaker_part:
                                activity_data["speaker"] = speaker_part
                        
                        # Extract device (text after location)
                        device_part = info_line[location_index + len(found_location):].strip()
                        if device_part:
                            activity_data["device"] = device_part
                    else:
                        # If no known location found, try alternative parsing
                        # Split by space and assume first part might contain speaker+location
                        parts = info_line.split()
                        if len(parts) >= 2:
                            # Last part is device
                            activity_data["device"] = parts[-1]
                            
                            # The rest might contain speaker and location
                            remaining = ' '.join(parts[:-1])
                            # If it contains a space, it might be "Location Device" format
                            if ' ' in remaining:
                                activity_data["location"] = remaining.split()[0]
                            else:
                                # Try to extract speaker from concatenated string
                                # Look for capitalization pattern: NameLocation
                                match = re.match(r'^([A-Z][a-z]+)([A-Z][a-z]+)$', remaining)
                                if match:
                                    speaker, location = match.groups()
                                    activity_data["speaker"] = speaker
                                    activity_data["location"] = location
                else:
                    # No speaker line, extract location and device from timestamp line
                    # Example: "Today 2:42 pm Bangalore echoshow8"
                    timestamp_parts = line.split()
                    if len(timestamp_parts) >= 5:
                        # Find the location (it's after the time)
                        # Look for the position after time (XX:XX pm/am)
                        time_end_index = None
                        for idx, part in enumerate(timestamp_parts):
                            if ':' in part and idx > 0:
                                time_end_index = idx + 1  # Include am/pm
                                break
                        
                        if time_end_index and time_end_index + 1 < len(timestamp_parts):
                            activity_data["location"] = timestamp_parts[time_end_index]
                            activity_data["device"] = " ".join(timestamp_parts[time_end_index + 1:])
                
                break
        
        detailed_transcripts.append(activity_data)
    
    return detailed_transcripts

# Load audio URLs from a JSON file.
with open("backend/audio_urls.json", 'r') as f:
    audio_urls = json.load(f)

# Extract detailed transcripts from the transcript file.
transcripts_data = extract_detailed_transcripts('alexa_activity_log.txt')

print("Extracted Detailed Transcript Data:")
for entry in transcripts_data:
    print(f"Activity {entry['activity_number']}:")
    print(f"  Transcript: {entry['transcript']}")
    print(f"  Type: {entry['type']}")
    print(f"  Timestamp: {entry['timestamp']}")
    print(f"  Speaker: {entry['speaker']}")
    print(f"  Location: {entry['location']}")
    print(f"  Device: {entry['device']}")
    print()

# Match audio URLs with transcript data in order.
matched = {}
for url, entry in zip(audio_urls, transcripts_data):
    # Remove activity_number from the entry since it's redundant in the mapping
    entry_copy = entry.copy()
    del entry_copy["activity_number"]
    matched[url] = entry_copy

# Output the mapping as JSON.
matched_json = json.dumps(matched, indent=2)
print("\nMatched Audio URLs with Detailed Transcripts:")
print(matched_json)

# Write the mapping to a JSON file.
with open("matched_audio_transcripts.json", "w") as f:
    json.dump(matched, f, indent=2)

print(f"\n✅ Detailed mapping saved to: matched_audio_transcripts.json")