const express = require('express');
const cors = require('cors');
const app = express();
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');

app.use(cors());
app.use(express.json());

app.get('/api/packet-report', (req, res) => {
  const { email, password, source } = req.query;
  console.log('Received email:', email);
  console.log('Received password:', password);
  console.log('Request came from:', source);
  
  if (source === 'SmartWatch') {
    console.log("Source is SmartWatch");
    
    // Define the paths to the Python scripts.
    const script1 = path.join(__dirname, 'samsung_adb.py');
    const script2 = path.join(__dirname, 'report_gen.py');
    const script3 = path.join(__dirname, 'generateTimeline.py');
    
    // Execute all three Python scripts sequentially.
    exec(`python ${script1} && python ${script2} && python ${script3}`, (err, stdout, stderr) => {
      if (err) {
        console.error('Error executing Python scripts:', err);
        res.status(500).send('Error generating DOCX file');
        return;
      }
      console.log('Python scripts output:', stdout);
      if (stderr) {
        console.error('Python scripts stderr:', stderr);
      }
      
      // Once the Python scripts complete, hash the DOCX file.
      const docxPath = path.join(__dirname, '..', 'Forensic_Log_Report.docx');
      const hashScript = path.join(__dirname, 'hash.py');
      exec(`python ${hashScript} ${docxPath}`, (hashErr, hashStdout, hashStderr) => {
        if (hashErr) {
          console.error("Error computing hash for DOCX file:", hashErr);
        } else {
          console.log("Hash for DOCX file:", hashStdout.trim());
        }
        // Now send the DOCX file.
        res.sendFile(docxPath, (err) => {
          if (err) {
            console.error('Error sending DOCX file:', err);
            res.status(500).send('Error sending DOCX file');
          } else {
            console.log("Sent file from", docxPath);
          }
        });
      });
    });
    
  } else {
    console.log("Source is neither SmartWatch nor SmartAssistant");
    const jsonPath = path.join(__dirname, 'packet_report.json');
    res.sendFile(jsonPath, (err) => {
      if (err) {
        console.error('Error sending JSON file:', err);
        res.status(500).send('Error sending JSON file');
      }
    });
  }
});

// POST route for SmartAssistant (all logic and logs moved here)
app.post('/api/packet-report', (req, res) => {
  const { email, password, source } = req.body;
  console.log('Received email:', email);
  console.log('Received password:', password);
  console.log('Request came from:', source);

  if (source !== 'SmartAssistant') {
    return res.status(400).send('Invalid source');
  }

  const cookiesScript = path.join(__dirname, 'GenerateAmazonCookie.js');
  const fetchScript = path.join(__dirname, 'fetchAlexaActivity.py');
  const syncScript = path.join(__dirname, 'SyncAudioTranscripts.py');
  const hashScript = path.join(__dirname, 'hash.py');
  const jsonPath = path.join(__dirname, '..', 'matched_audio_transcripts.json');

  // Pass credentials as env ONLY to child processes for this request
  const env = { ...process.env, AMAZON_EMAIL: email, AMAZON_PASSWORD: password };

  console.log("[SmartAssistant] Step 1: Generating Amazon cookies...");
  exec(`node ${cookiesScript}`, { env }, (err, stdout, stderr) => {
    if (err) {
      console.error('[SmartAssistant] Error generating cookies:', err);
      if (stderr) console.error('[SmartAssistant] STDERR (cookies):', stderr);
      if (stdout) console.error('[SmartAssistant] STDOUT (cookies):', stdout);
      res.status(500).send('Error generating cookies');
      return;
    }
    console.log('[SmartAssistant] Cookies generated successfully.');
    if (stdout) console.log('[SmartAssistant] STDOUT (cookies):', stdout);

    console.log("[SmartAssistant] Step 2: Fetching Alexa activity...");
    exec(`python ${fetchScript}`, { env }, (err, stdout, stderr) => {
      if (err) {
        console.error('[SmartAssistant] Error fetching Alexa activity:', err);
        if (stderr) console.error('[SmartAssistant] STDERR (fetchAlexaActivity):', stderr);
        if (stdout) console.error('[SmartAssistant] STDOUT (fetchAlexaActivity):', stdout);
        res.status(500).send('Error fetching Alexa activity');
        return;
      }
      console.log('[SmartAssistant] Alexa activity fetched successfully.');
      if (stdout) console.log('[SmartAssistant] STDOUT (fetchAlexaActivity):', stdout);

      console.log("[SmartAssistant] Step 3: Syncing audio transcripts...");
      exec(`python ${syncScript}`, { env }, (err, stdout, stderr) => {
        if (err) {
          console.error('[SmartAssistant] Error syncing transcripts:', err);
          if (stderr) console.error('[SmartAssistant] STDERR (SyncAudioTranscripts):', stderr);
          res.status(500).send('Error syncing transcripts');
          return;
        }
        console.log('[SmartAssistant] Audio transcripts synced successfully.');
        if (stdout) console.log('[SmartAssistant] STDOUT (SyncAudioTranscripts):', stdout);

        console.log("[SmartAssistant] Step 4: Hashing and sending JSON...");
        exec(`python ${hashScript} ${jsonPath}`, { env }, (hashErr, hashStdout, hashStderr) => {
          if (hashErr) {
            console.error('[SmartAssistant] Error hashing JSON file:', hashErr);
            if (hashStderr) console.error('[SmartAssistant] STDERR (hash):', hashStderr);
            res.status(500).send('Error hashing JSON file');
            return;
          }
          console.log('[SmartAssistant] JSON file hash:', hashStdout.trim());
          res.download(jsonPath, 'matched_audio_transcripts.json', (downloadErr) => {
            if (downloadErr) {
              console.error('[SmartAssistant] Error sending JSON file:', downloadErr);
              res.status(500).send('Error sending JSON file');
            } else {
              console.log('[SmartAssistant] matched_audio_transcripts.json sent successfully.');
            }
          });
        });
      });
    });
  });
});

const PORT = 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
