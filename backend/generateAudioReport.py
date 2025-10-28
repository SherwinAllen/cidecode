import json
import os
import base64
from datetime import datetime
import re
import shutil

def parse_timestamp(timestamp_str):
    """Parse timestamp string to datetime object for sorting"""
    try:
        # Handle various timestamp formats from Alexa
        if 'Today' in timestamp_str:
            today = datetime.now()
            time_part = timestamp_str.replace('Today', '').strip()
            return datetime.combine(today.date(), datetime.strptime(time_part, '%I:%M %p').time())
        elif 'Yesterday' in timestamp_str:
            yesterday = datetime.now().replace(day=datetime.now().day-1)
            time_part = timestamp_str.replace('Yesterday', '').strip()
            return datetime.combine(yesterday.date(), datetime.strptime(time_part, '%I:%M %p').time())
        else:
            # Handle full date strings like "20 October 2025 8:36 am"
            formats = [
                "%d %B %Y %I:%M %p",
                "%d %B %Y %I:%M%p",
                "%d %B, %Y %I:%M %p"
            ]
            for fmt in formats:
                try:
                    return datetime.strptime(timestamp_str, fmt)
                except ValueError:
                    continue
            return datetime.min
    except Exception:
        return datetime.min

def generate_html_report(audio_data_map, output_file="smart_assistant_report.html"):
    """Generate a comprehensive HTML report with embedded audio - HANDLES 0 ACTIVITIES"""
    
    # Group by device
    devices_data = {}
    
    for audio_url, data in audio_data_map.items():
        transcript_data = data['transcript_data']
        device = transcript_data.get('device', 'Unknown Device')
        
        # Ensure device name is properly formatted
        if not device or device == 'Unknown':
            device = 'Unknown Device'
        
        if device not in devices_data:
            devices_data[device] = []
        
        devices_data[device].append({
            'timestamp': transcript_data.get('timestamp', 'Unknown'),
            'timestamp_obj': parse_timestamp(transcript_data.get('timestamp', '')),
            'transcript': transcript_data.get('transcript', ''),
            'speaker': transcript_data.get('speaker', ''),
            'audio_info': data.get('audio_info'),
            'audio_url': audio_url
        })
    
    # Sort each device's activities by timestamp (newest first)
    for device in devices_data:
        devices_data[device].sort(key=lambda x: x['timestamp_obj'], reverse=True)
    
    # Calculate statistics
    total_activities = sum(len(activities) for activities in devices_data.values())
    total_audio = sum(1 for data in audio_data_map.values() if data.get('audio_info'))
    total_devices = len(devices_data)
    
    # Generate HTML
    html_content = f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Amazon Smart Assistant Voice Activity Analysis Report</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Source+Code+Pro:wght@400;500&display=swap" rel="stylesheet">
        <style>
            :root {{
                --primary-dark: #1a365d;
                --primary-medium: #2d3748;
                --primary-light: #4a5568;
                --accent-blue: #3182ce;
                --accent-teal: #319795;
                --neutral-light: #f7fafc;
                --neutral-medium: #e2e8f0;
                --neutral-dark: #718096;
                --success: #38a169;
                --warning: #d69e2e;
                --border-radius: 8px;
                --shadow-sm: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08);
                --shadow-md: 0 4px 6px rgba(0,0,0,0.05), 0 10px 15px rgba(0,0,0,0.05);
                --shadow-lg: 0 10px 25px rgba(0,0,0,0.07), 0 5px 10px rgba(0,0,0,0.05);
            }}
            
            * {{
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }}
            
            body {{
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                line-height: 1.6;
                color: var(--primary-medium);
                background: linear-gradient(135deg, #f5f7fa 0%, #e4e8f0 100%);
                min-height: 100vh;
                font-weight: 400;
            }}
            
            .container {{
                max-width: 1200px;
                margin: 0 auto;
                padding: 20px;
            }}
            
            .report-header {{
                background: white;
                padding: 40px;
                border-radius: var(--border-radius);
                box-shadow: var(--shadow-md);
                margin-bottom: 30px;
                border-left: 4px solid var(--accent-blue);
            }}
            
            .report-title {{
                font-size: 2.5rem;
                font-weight: 700;
                color: var(--primary-dark);
                margin-bottom: 8px;
                letter-spacing: -0.025em;
            }}
            
            .report-subtitle {{
                font-size: 1.1rem;
                color: var(--primary-light);
                margin-bottom: 20px;
                font-weight: 400;
            }}
            
            .report-meta {{
                display: flex;
                gap: 30px;
                flex-wrap: wrap;
                padding-top: 20px;
                border-top: 1px solid var(--neutral-medium);
            }}
            
            .meta-item {{
                display: flex;
                align-items: center;
                gap: 8px;
                color: var(--primary-light);
                font-size: 0.9rem;
            }}
            
            .stats-grid {{
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
                margin-bottom: 30px;
            }}
            
            .stat-card {{
                background: white;
                padding: 25px;
                border-radius: var(--border-radius);
                box-shadow: var(--shadow-sm);
                text-align: center;
                border-top: 3px solid var(--accent-blue);
                transition: transform 0.2s ease, box-shadow 0.2s ease;
            }}
            
            .stat-card:hover {{
                transform: translateY(-2px);
                box-shadow: var(--shadow-md);
            }}
            
            .stat-number {{
                font-size: 2.2rem;
                font-weight: 700;
                color: var(--primary-dark);
                margin-bottom: 5px;
            }}
            
            .stat-label {{
                font-size: 0.85rem;
                color: var(--neutral-dark);
                text-transform: uppercase;
                letter-spacing: 0.05em;
                font-weight: 500;
            }}
            
            .device-section {{
                background: white;
                border-radius: var(--border-radius);
                box-shadow: var(--shadow-sm);
                margin-bottom: 30px;
                overflow: hidden;
            }}
            
            .device-header {{
                background: var(--primary-dark);
                color: white;
                padding: 20px 25px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }}
            
            .device-name {{
                font-size: 1.3rem;
                font-weight: 600;
            }}
            
            .activity-count {{
                background: rgba(255, 255, 255, 0.15);
                padding: 5px 12px;
                border-radius: 20px;
                font-size: 0.85rem;
                font-weight: 500;
            }}
            
            .activity-list {{
                padding: 0;
            }}
            
            .activity-item {{
                padding: 30px;
                border-bottom: 1px solid var(--neutral-medium);
                transition: background-color 0.2s ease;
            }}
            
            .activity-item:hover {{
                background-color: var(--neutral-light);
            }}
            
            .activity-item:last-child {{
                border-bottom: none;
            }}
            
            .activity-header {{
                display: flex;
                justify-content: between;
                align-items: flex-start;
                margin-bottom: 20px;
            }}
            
            .activity-timestamp {{
                font-family: 'Source Code Pro', monospace;
                font-size: 0.9rem;
                color: var(--accent-teal);
                background: rgba(49, 151, 149, 0.08);
                padding: 6px 12px;
                border-radius: 4px;
                font-weight: 500;
                border-left: 2px solid var(--accent-teal);
            }}
            
            .audio-section {{
                margin: 20px 0;
            }}
            
            .audio-player {{
                width: 100%;
                max-width: 500px;
                border-radius: 6px;
                background: var(--neutral-light);
                padding: 15px;
                border: 1px solid var(--neutral-medium);
            }}
            
            .audio-player audio {{
                width: 100%;
                border-radius: 4px;
            }}
            
            .no-audio {{
                color: var(--neutral-dark);
                font-style: italic;
                padding: 15px;
                background: var(--neutral-light);
                border-radius: 4px;
                text-align: center;
                border: 1px dashed var(--neutral-medium);
            }}
            
            .transcript-section {{
                margin: 25px 0;
            }}
            
            .transcript-label {{
                font-size: 0.85rem;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: var(--neutral-dark);
                margin-bottom: 10px;
                font-weight: 600;
            }}
            
            .transcript-content {{
                background: var(--neutral-light);
                padding: 20px;
                border-radius: 6px;
                border-left: 3px solid var(--accent-blue);
                font-size: 1.05rem;
                line-height: 1.7;
                color: var(--primary-medium);
            }}
            
            .speaker-section {{
                margin-top: 15px;
            }}
            
            .speaker-label {{
                font-size: 0.85rem;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: var(--neutral-dark);
                margin-bottom: 8px;
                font-weight: 600;
            }}
            
            .speaker-name {{
                display: inline-block;
                background: rgba(56, 161, 105, 0.1);
                color: var(--success);
                padding: 6px 12px;
                border-radius: 4px;
                font-weight: 500;
                border-left: 2px solid var(--success);
            }}
            
            .divider {{
                height: 1px;
                background: linear-gradient(to right, transparent, var(--neutral-medium), transparent);
                margin: 40px 0;
            }}
            
            .report-footer {{
                text-align: center;
                padding: 30px;
                color: var(--neutral-dark);
                font-size: 0.9rem;
            }}
            
            .empty-state {{
                text-align: center;
                padding: 60px 40px;
                color: var(--neutral-dark);
            }}
            
            .empty-icon {{
                font-size: 4rem;
                margin-bottom: 20px;
                opacity: 0.5;
            }}
            
            .empty-title {{
                font-size: 1.5rem;
                margin-bottom: 15px;
                color: var(--primary-light);
            }}
            
            .empty-description {{
                font-size: 1.1rem;
                line-height: 1.6;
                max-width: 600px;
                margin: 0 auto;
            }}
            
            @media (max-width: 768px) {{
                .container {{
                    padding: 15px;
                }}
                
                .report-header {{
                    padding: 25px;
                }}
                
                .report-title {{
                    font-size: 2rem;
                }}
                
                .activity-item {{
                    padding: 20px;
                }}
                
                .stats-grid {{
                    grid-template-columns: 1fr;
                }}
            }}
        </style>
    </head>
    <body>
        <div class="container">
            <header class="report-header">
                <h1 class="report-title">Amazon Smart Assistant Voice Activity Analysis Report</h1>
                <p class="report-subtitle">Comprehensive analysis of voice interactions and transcriptions</p>
                
                <div class="report-meta">
                    <div class="meta-item">
                        <span>Generated:</span>
                        <strong>{datetime.now().strftime("%B %d, %Y at %I:%M %p")}</strong>
                    </div>
                    <div class="meta-item">
                        <span>Data Source:</span>
                        <strong>Amazon Smart Assistant Voice Recordings</strong>
                    </div>
                    <div class="meta-item">
                        <span>Report Type:</span>
                        <strong>Comprehensive Analysis</strong>
                    </div>
                </div>
            </header>
    """
    
    # Add statistics - ALWAYS SHOW STATS EVEN FOR 0 ACTIVITIES
    html_content += f"""
            <section class="stats-grid">
                <div class="stat-card">
                    <div class="stat-number">{total_activities}</div>
                    <div class="stat-label">Total Interactions</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">{total_audio}</div>
                    <div class="stat-label">Audio Recordings</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">{total_devices}</div>
                    <div class="stat-label">Active Devices</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">{len(audio_data_map)}</div>
                    <div class="stat-label">Processed Entries</div>
                </div>
            </section>
    """
    
    # Handle case when there are no activities
    if total_activities == 0:
        html_content += """
            <section class="device-section">
                <header class="device-header">
                    <div class="device-name">No Voice Activities Found</div>
                    <div class="activity-count">0 Activities</div>
                </header>
                
                <div class="empty-state">
                    <div class="empty-icon">🎤</div>
                    <h2 class="empty-title">No Amazon Smart Assistant Voice Activities Found</h2>
                    <div class="empty-description">
                        <p>No voice interactions were found in your Smart Assistant history for the selected time period (Last 7 days).</p>
                        <p style="margin-top: 15px;">This could be because:</p>
                        <ul style="text-align: left; max-width: 400px; margin: 20px auto;">
                            <li>No voice commands were issued to Smart Assistant devices</li>
                            <li>Activities are outside the 7-day search window</li>
                            <li>Your account has voice history disabled</li>
                            <li>Technical issues with data retrieval</li>
                        </ul>
                        <p>Try expanding your search timeframe or check your Smart Assistant privacy settings.</p>
                    </div>
                </div>
            </section>
        """
    else:
        # Add device sections when there are activities
        for device, activities in devices_data.items():
            html_content += f"""
                <section class="device-section">
                    <header class="device-header">
                        <div class="device-name">{device}</div>
                        <div class="activity-count">{len(activities)} Activities</div>
                    </header>
                    
                    <div class="activity-list">
            """
            
            for idx, activity in enumerate(activities, 1):
                # Audio section
                audio_html = ""
                if activity['audio_info']:
                    content_type = activity['audio_info']['content_type']
                    base64_data = activity['audio_info']['base64']
                    audio_html = f"""
                        <div class="audio-section">
                            <div class="audio-player">
                                <audio controls>
                                    <source src="data:{content_type};base64,{base64_data}" type="{content_type}">
                                    Your browser does not support the audio element.
                                </audio>
                            </div>
                        </div>
                    """
                else:
                    audio_html = """
                        <div class="audio-section">
                            <div class="no-audio">Audio recording not available for this interaction</div>
                        </div>
                    """
                
                # Speaker section
                speaker_html = ""
                if activity['speaker'] and activity['speaker'] not in ['Unknown', 'undefined']:
                    speaker_html = f"""
                        <div class="speaker-section">
                            <div class="speaker-label">Identified Speaker</div>
                            <div class="speaker-name">{activity['speaker']}</div>
                        </div>
                    """
                
                html_content += f"""
                        <div class="activity-item">
                            <div class="activity-header">
                                <div class="activity-timestamp">Recorded: {activity['timestamp']}</div>
                            </div>
                            
                            {audio_html}
                            
                            <div class="transcript-section">
                                <div class="transcript-label">Transcribed Content</div>
                                <div class="transcript-content">
                                    {activity['transcript'] if activity['transcript'] else "No transcript available for this recording"}
                                </div>
                            </div>
                            
                            {speaker_html}
                        </div>
                """
                
                # Add subtle divider between activities (except for the last one)
                if idx < len(activities):
                    html_content += '<div style="height: 1px; background: #e2e8f0; margin: 0 30px;"></div>'
            
            html_content += """
                    </div>
                </section>
            """
    
    # Add footer
    html_content += f"""
            <div class="divider"></div>
            
            <footer class="report-footer">
                <p>Confidential Report • Generated by Amazon Smart Assistant Voice Analysis System</p>
                <p style="margin-top: 8px; font-size: 0.8rem;">
                    This report contains {total_activities} voice interactions across {total_devices} devices
                </p>
            </footer>
        </div>
    </body>
    </html>
    """
    
    # Write HTML file
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(html_content)
    
    print(f"Professional HTML report generated: {output_file}")
    return output_file

def cleanup_audio_files(audio_data_map):
    """Delete all downloaded audio files to save storage space"""
    audio_dir = "downloaded_audio"
    
    if os.path.exists(audio_dir):
        try:
            # Delete all files in the directory
            for filename in os.listdir(audio_dir):
                file_path = os.path.join(audio_dir, filename)
                try:
                    if os.path.isfile(file_path):
                        os.unlink(file_path)
                        print(f"Deleted audio file: {filename}")
                except Exception as e:
                    print(f"Error deleting {file_path}: {e}")
            
            # Remove the directory itself
            os.rmdir(audio_dir)
            print(f"Cleaned up audio directory: {audio_dir}")
            
        except Exception as e:
            print(f"Error cleaning up audio directory: {e}")
    else:
        print("No audio directory found to clean up")

def cleanup_enhanced_file():
    """Clean up enhanced_audio_transcripts.json after successful processing"""
    enhanced_file = "enhanced_audio_transcripts.json"
    try:
        if os.path.exists(enhanced_file):
            os.remove(enhanced_file)
            print(f"🧹 Deleted: {enhanced_file}")
    except Exception as e:
        print(f"⚠️ Warning: Could not clean up {enhanced_file}: {e}")

def main():
    """Main function to generate comprehensive reports"""
    enhanced_file = "enhanced_audio_transcripts.json"
    
    if not os.path.exists(enhanced_file):
        print("Enhanced data file not found. Running audio download...")
        from downloadAlexaAudio import process_all_audio_files
        audio_data_map = process_all_audio_files()
        if not audio_data_map:
            return
    else:
        with open(enhanced_file, 'r', encoding='utf-8') as f:
            audio_data_map = json.load(f)
    
    print("Generating professional reports...")
    
    # Generate HTML report
    html_file = generate_html_report(audio_data_map)
    
    # Clean up audio files after report generation
    print("Cleaning up temporary audio files...")
    cleanup_audio_files(audio_data_map)
    
    # Clean up enhanced file after successful report generation
    print("Cleaning up intermediate files...")
    cleanup_enhanced_file()
    
    print(f"\nREPORT GENERATION COMPLETE!")
    print(f"HTML Report: {html_file}")
    print(f"All audio files are embedded and accessible")
    print(f"Temporary audio files and intermediate files have been cleaned up")

if __name__ == "__main__":
    main()