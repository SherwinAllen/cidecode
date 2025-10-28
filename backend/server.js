const express = require('express');
const cors = require('cors');
const app = express();
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const { randomUUID } = require('crypto');
const tar = require('tar-stream');


app.use(cors());
app.use(express.json());

// Serve static files from the backup directory
app.use('/api/files', express.static(path.join(__dirname, 'backup')));

// Download file from device
app.get('/api/download-file', async (req, res) => {
  const filePath = req.query.path;
  
  if (!filePath) {
    return res.status(400).json({ error: 'File path is required' });
  }
  
  try {
    await checkAdbDevice();
    
    // Pull file to temporary location
    const tempDir = path.join(__dirname, 'temp_files');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const fileName = path.basename(filePath);
    const localPath = path.join(tempDir, fileName);
    
    console.log(`📥 Pulling file: ${filePath}`);
    await runAdbCommand(`adb pull "/sdcard/${filePath}" "${localPath}"`);
    
    // Determine content type
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.txt': 'text/plain',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.pdf': 'application/pdf',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript'
    };
    
    const contentType = contentTypes[ext] || 'application/octet-stream';
    
    // Send file
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    
    const fileStream = fs.createReadStream(localPath);
    fileStream.pipe(res);
    
    // Clean up temp file after sending
    fileStream.on('end', () => {
      setTimeout(() => {
        fs.unlink(localPath, (err) => {
          if (err) console.error('Error deleting temp file:', err);
        });
      }, 1000);
    });
    
  } catch (err) {
    console.error('Error downloading file:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get file preview (for text files)
app.get('/api/file-preview', async (req, res) => {
  const filePath = req.query.path;
  const includeContent = req.query.include_content === 'true';
  console.log("The path sent to the preview:", filePath)
  if (!filePath) {
    return res.status(400).json({ error: 'File path is required' });
  }
  
  // Security: Basic path validation
  if (filePath.includes('..') || filePath.includes('//')) {
    return res.status(400).json({ error: 'Invalid file path' });
  }
  
  try {
    await checkAdbDevice();
    
    // Get file info first
    const fileInfo = await runAdbCommand(`adb shell "stat -c '%s' '/sdcard/${filePath}'"`);
    const fileSize = parseInt(fileInfo.trim());
    
    if (isNaN(fileSize)) {
      return res.status(404).json({ error: 'File not found or inaccessible' });
    }
    
    const ext = path.extname(filePath).toLowerCase();
    console.log("Lenght is:",ext.length)
    const isTextFile = ['.txt', '.json', '.xml', '.html', '.css', '.js', '.log', '.md', '.csv'].includes(ext);
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext);
    const isAudio = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(ext);
    
    // Determine MIME type
    let mimeType = 'application/octet-stream';
    if (isTextFile) {
      if (ext === '.json') mimeType = 'application/json';
      else if (ext === '.html') mimeType = 'text/html';
      else if (ext === '.css') mimeType = 'text/css';
      else if (ext === '.js') mimeType = 'application/javascript';
      else mimeType = 'text/plain';
    } else if (isImage) {
      if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
      else if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.bmp') mimeType = 'image/bmp';
      else if (ext === '.webp') mimeType = 'image/webp';
    } else if (isAudio) {
      if (ext === '.mp3') mimeType = 'audio/mpeg';
      else if (ext === '.wav') mimeType = 'audio/wav';
      else if (ext === '.ogg') mimeType = 'audio/ogg';
      else if (ext === '.m4a') mimeType = 'audio/mp4';
      else if (ext === '.flac') mimeType = 'audio/flac';
      else mimeType = 'audio/mpeg';
    }
    console.log("The audio extension is:",isAudio)
    const response = {
      path: filePath,
      name: path.basename(filePath),
      size: fileSize,
      mimeType: mimeType,
      isText: isTextFile,
      preview: 'Binary file'
    };
    
    // Only load content if explicitly requested and file is small enough
    if (includeContent) { // 1MB limit
      try {
        if (isTextFile) {
          // For text files, get content directly
          const fileContent = await runAdbCommand(`adb shell "cat '/sdcard/${filePath}'"`, { 
            maxBuffer: 1024 * 1024 * 1024 * 1024 * 1024 
          });
          response.content = fileContent;
          response.preview = fileContent.substring(0, 200) + (fileContent.length > 200 ? '...' : '');
        } else if (isImage || isAudio) {
          // For images, get base64 content
          const base64Content = await runAdbCommand(`adb shell "cat '/sdcard/${filePath}' | base64"`, {
            maxBuffer: 1024 * 1024 * 1024 * 1024 * 1024  // 5MB for base64 encoded images
          });
          response.content = base64Content.trim();
          response.encoding = 'base64';
          response.preview = `Image file (${fileSize} bytes)`;
        }
      } catch (contentError) {
        console.warn(`Could not load content for ${filePath}:`, contentError.message);
        // Don't fail the entire request if content can't be loaded
      }
    } else if (isTextFile && fileSize < 1024 * 10) { // Auto-include small text files (<10KB)
      try {
        const fileContent = await runAdbCommand(`adb shell "cat '/sdcard/${filePath}'"`);
        response.content = fileContent;
        response.preview = fileContent.substring(0, 200) + (fileContent.length > 200 ? '...' : '');
      } catch (contentError) {
        // Ignore errors for small files
      }
    }
    
    res.json(response);
    
  } catch (err) {
    console.error('Error getting file preview:', err);
    res.status(500).json({ error: err.message });
  }
});

async function checkAdbDevice() {
  try {
    const devicesOutput = await runAdbCommand('adb devices');
    const lines = devicesOutput.split('\n').filter(line => line.trim());
    
    // Skip the first line ("List of devices attached")
    const deviceLines = lines.slice(1);
    
    if (deviceLines.length === 0) {
      throw new Error('No devices connected');
    }

    const authorizedDevices = deviceLines.filter(line => line.includes('\tdevice'));
    if (authorizedDevices.length === 0) {
      throw new Error('No authorized devices found. Check USB debugging authorization.');
    }

    console.log(`✅ Found ${authorizedDevices.length} authorized device(s)`);
    return true;
  } catch (error) {
    throw new Error(`Device check failed: ${error.message}`);
  }
}

function runAdbCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`🔧 Running ADB: ${command}`);
    exec(command, { maxBuffer: 1024 * 1024 * 100, ...options }, (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ ADB command failed: ${error.message}`);
        reject(new Error(`ADB command failed: ${stderr || error.message}`));
        return;
      }
      if (stderr && !options.ignoreStderr) {
        console.warn(`⚠️ ADB stderr: ${stderr}`);
      }
      resolve(stdout);
    });
  });
}

// Proper recursive folder scanning
async function scanFolderRecursive(basePath, currentPath = '', depth = 0) {
  const fullPath = basePath + currentPath;
  
  // Safety limit to prevent infinite recursion
  if (depth > 8) {
    return {
      name: currentPath.split('/').pop() || 'sdcard',
      type: 'folder',
      path: currentPath,
      children: [],
      partial: true,
      info: 'Depth limit reached'
    };
  }
  
  try {
    console.log(`📁 Scanning (depth ${depth}): ${fullPath}`);
    
    // Get all items (simple list)
    const itemsOutput = await runAdbCommand(`adb shell "ls -1 '${fullPath}'"`, { ignoreStderr: true });
    const items = itemsOutput.split('\n').filter(item => item.trim());
    
    const folderNode = {
      name: currentPath.split('/').pop() || 'sdcard',
      type: 'folder',
      path: currentPath,
      children: []
    };

    for (const itemName of items) {
      if (!itemName || itemName === '.' || itemName === '..') continue;
      
      const fullItemPath = `${fullPath}/${itemName}`;
      const relativePath = currentPath ? `${currentPath}/${itemName}` : itemName;
      
      // Check if it's a directory
      const isDir = await runAdbCommand(`adb shell "if [ -d '${fullItemPath}' ]; then echo 'dir'; fi"`, { 
        ignoreStderr: true 
      }).then(output => output.includes('dir')).catch(() => false);
      
      if (isDir) {
        // RECURSIVE CALL - scan the subfolder
        try {
          const subFolder = await scanFolderRecursive(basePath, relativePath, depth + 1);
          folderNode.children.push(subFolder);
        } catch (subError) {
          folderNode.children.push({
            name: itemName,
            type: 'folder',
            path: relativePath,
            children: [],
            error: subError.message,
            partial: true
          });
        }
      } else {
        // It's a file
        folderNode.children.push({
          name: itemName,
          type: 'file',
          path: relativePath
        });
      }
    }

    console.log(`✅ ${fullPath}: ${folderNode.children.length} items`);
    return folderNode;
    
  } catch (error) {
    console.error(`❌ Error scanning folder ${fullPath}:`, error.message);
    throw error;
  }
}

// NEW: Get list of top-level folders in /sdcard
app.get('/api/scan-folders', async (req, res) => {
  try {
    console.log('🔍 Scanning for top-level folders...');
    await checkAdbDevice();
    
    const lsOutput = await runAdbCommand('adb shell ls -la /sdcard/', { ignoreStderr: true });
    const lines = lsOutput.split('\n').filter(line => line.trim());
    
    const folderNames = [];
    
    for (const line of lines) {
      if (line.startsWith('d')) { // Directory lines
        const parts = line.split(/\s+/);
        const name = parts[parts.length - 2];
        console.log("Folder name is:",name);
        
        if (name && !name.startsWith('.') && name !== 'Android' && name !== 'lost+found') {
          folderNames.push(name);
        }
      }
    }
    
    //Always include these common folders if they exist
    const commonFolders = ['DCIM', 'Download', 'Pictures', 'Music', 'Documents', 'Movies'];
    for (const folder of commonFolders) {
      if (!folderNames.includes(folder)) {
        folderNames.push(folder);
      }
    }
    
    console.log(`✅ Found ${folderNames.length} folders:`, folderNames);
    res.json(folderNames);
  } catch (err) {
    console.error('❌ Folder scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// NEW: Get contents of a specific folder
app.get('/api/scan-folder', async (req, res) => {
  const folderPath = req.query.path;
  
  if (!folderPath) {
    return res.status(400).json({ error: 'Folder path is required' });
  }
  
  try {
    console.log(`🔍 Scanning folder: ${folderPath}`);
    await checkAdbDevice();
    
    const folderData = await scanFolderRecursive('/sdcard/', folderPath);
    res.json(folderData);
  } catch (err) {
    console.error(`❌ Error scanning folder ${folderPath}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// NEW: Quick scan of common folders only (faster alternative)
app.get('/api/quick-scan', async (req, res) => {
  try {
    console.log('🚀 Starting quick scan of common folders...');
    await checkAdbDevice();
    
    const commonFolders = ['DCIM', 'Download', 'Pictures', 'Music', 'Documents', 'Movies', 'Podcasts'];
    const root = {
      name: 'sdcard',
      type: 'folder',
      children: []
    };
    
    for (const folder of commonFolders) {
      try {
        console.log(`🔍 Quick scanning: ${folder}`);
        // Check if folder exists and get basic info
        const exists = await runAdbCommand(`adb shell "test -d /sdcard/${folder} && echo exists"`, { ignoreStderr: true })
          .then(output => output.includes('exists'))
          .catch(() => false);
        
        if (exists) {
          // Get file count for this folder
          const fileCount = await runAdbCommand(`adb shell "find /sdcard/${folder} -type f | wc -l"`, { ignoreStderr: true })
            .then(output => parseInt(output.trim()) || 0)
            .catch(() => 0);
          
          root.children.push({
            name: folder,
            type: 'folder',
            path: folder,
            fileCount: fileCount,
            children: [] // Don't recursively scan in quick mode
          });
        }
      } catch (error) {
        root.children.push({
          name: folder,
          type: 'folder',
          path: folder,
          error: error.message,
          children: []
        });
      }
    }
    
    console.log('✅ Quick scan completed');
    res.json(root);
  } catch (err) {
    console.error('❌ Quick scan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Original filesystem endpoint (with fallback)
app.get('/api/filesystem', async (req, res) => {
  try {
    console.log('🔄 Starting filesystem fetch from smartwatch...');
    
    // ✅ Just call the performQuickScan function we created earlier
    const result = await performQuickScan();
    res.json(result);
    
  } catch (err) {
    console.error('❌ Filesystem fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// NEW: Device status endpoint for frontend
app.get('/api/device-status', async (req, res) => {
  try {
    await checkAdbDevice();
    res.json({ 
      status: 'connected',
      message: 'Device is connected and authorized'
    });
  } catch (error) {
    res.json({
      status: 'disconnected',
      message: error.message
    });
  }
});



// New API route
app.get('/api/filesystem', async (req, res) => {
  try {
    console.log('Fetching filesystem from smartwatch...');
    const fsTree = await buildFilesystemTree();
    res.json(fsTree);
  } catch (err) {
    console.error('❌ Filesystem fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Simple GET endpoint used previously by SmartWatch flows
app.get('/api/packet-report', async (req, res) => {
  const { source } = req.query;
  console.log('Request came from:', source);

  if (source === 'SmartWatch') {
    try {
      const script1 = path.join(__dirname, 'samsung_adb.py');
      const script2 = path.join(__dirname, 'report_gen.py');

      console.log("Executing Python scripts for SmartWatch...");
      
      // Run the scripts sequentially
      await new Promise((resolve, reject) => {
        exec(
          'python "C:\\Users\\shamb\\OneDrive\\Documents\\CIDECODE\\cidecode\\backend\\samsung_adb.py" && python "C:\\Users\\shamb\\OneDrive\\Documents\\CIDECODE\\cidecode\\backend\\report_gen.py" && python "C:\\Users\\shamb\\OneDrive\\Documents\\CIDECODE\\logcat_llm_test.py"',
          { maxBuffer: 1024 * 1024 * 50 },
          (error, stdout, stderr) => {
            if (error) {
              console.error(`Error generating SmartWatch report: ${error}`);
              return reject(error);
            }

            console.log("✅ Report generated successfully!");
            console.log(stdout);
            resolve(); 
          }
        );
      });
      // Path to the generated DOCX
      const docxPath = path.join(__dirname, '..', 'Forensic_Log_Report.docx');

      // ✅ Read artifacts from JSON file instead of .txt
      const jsonPath = path.join(__dirname,  "..", 'packet_report.json');
      let artifacts = {};

      if (fs.existsSync(jsonPath)) {
        jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        artifacts = jsonData.artifacts || {};  // Ensure your package.json has an "artifacts" key
      }

      console.log("Artifacts loaded:", Object.keys(artifacts));

      // ✅ Return JSON (not a blob)
      res.json({
        success: true,
        docxFileName: 'Forensic_Log_Report.docx',
        downloadUrl: '/api/download/Forensic_Log_Report.docx',
        artifacts
      });

    } catch (err) {
      console.error('Error generating SmartWatch report:', err);
      res.status(500).json({ error: 'Failed to generate SmartWatch report', details: err.message });
    }
  } else {
    // You can keep your existing SmartAssistant / fallback JSON logic
    console.log('Source is neither SmartWatch nor SmartAssistant');
    const jsonPath = path.join(__dirname, 'packet_report.json');
    res.sendFile(jsonPath, (err) => {
      if (err) {
        console.error('Error sending JSON file:', err);
        res.status(500).send('Error sending JSON file');
      }
    });
  }
});

app.get('/api/download/:fileName', (req, res) => {
  const fileName = req.params.fileName;
  const filePath = path.join(__dirname, '..', fileName);

  if (!fs.existsSync(filePath)) {
    console.error("File not found:", filePath);
    return res.status(404).send('File not found');
  }

  res.download(filePath);
});


const requests = {};

app.post('/api/packet-report', (req, res) => {
  const { email, password, source } = req.body;
  console.log('Received email:', email);
  console.log('Received password:', password ? '***' : null);
  console.log('Request came from:', source);

  if (source !== 'SmartAssistant') {
    return res.status(400).send('Invalid source');
  }

  // create request id and initial state
  const requestId = randomUUID();
  requests[requestId] = {
    status: 'started',
    step: 'init',
    method: null,
    message: null,
    otp: null,
    filePath: null,
    done: false,
    error: null,
    userConfirmed2FA: false
  };

  // respond immediately with requestId so frontend can show UI
  res.json({ requestId });

  // run background pipeline for this request
  (async () => {
    const cookiesScript = path.join(__dirname, 'GenerateAmazonCookie.js');
    const fetchScript = path.join(__dirname, 'fetchAlexaActivity.py');
    const syncScript = path.join(__dirname, 'SyncAudioTranscripts.py');
    const hashScript = path.join(__dirname, 'hash.py');
    const jsonPath = path.join(__dirname, '..', 'matched_audio_transcripts.json');

    const env = { ...process.env, AMAZON_EMAIL: email, AMAZON_PASSWORD: password, REQUEST_ID: requestId };

    try {
      requests[requestId].step = 'cookies';
      requests[requestId].status = 'running';
      console.log(`[${requestId}] Step 1: Generating Amazon cookies (headless)...`);

      // spawn node script (so we can capture exit and not block main thread)
      const child = spawn('node', [cookiesScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });

      child.stdout.on('data', (d) => console.log(`[${requestId}] cookies stdout: ${d.toString()}`));
      child.stderr.on('data', (d) => console.error(`[${requestId}] cookies stderr: ${d.toString()}`));

      const exitCode = await new Promise((resolve) => child.on('close', resolve));
      if (exitCode !== 0) {
        throw new Error(`GenerateAmazonCookie exited with ${exitCode}`);
      }
      console.log(`[${requestId}] Cookies generated.`);

      // Step 2: fetch Alexa activity
      requests[requestId].step = 'fetch';
      requests[requestId].status = 'running';
      console.log(`[${requestId}] Step 2: Fetching Alexa activity...`);
      await new Promise((resolve, reject) => {
        exec(`python "${fetchScript}"`, { env }, (err, stdout, stderr) => {
          if (err) {
            console.error(`[${requestId}] fetch error:`, err);
            return reject(err);
          }
          console.log(`[${requestId}] fetchAlexaActivity stdout:`, stdout);
          if (stderr) console.error(`[${requestId}] fetchAlexaActivity stderr:`, stderr);
          resolve();
        });
      });

      // Step 3: Sync transcripts
      requests[requestId].step = 'sync';
      console.log(`[${requestId}] Step 3: Syncing audio transcripts...`);
      await new Promise((resolve, reject) => {
        exec(`python "${syncScript}"`, { env }, (err, stdout, stderr) => {
          if (err) {
            console.error(`[${requestId}] sync error:`, err);
            return reject(err);
          }
          console.log(`[${requestId}] SyncAudioTranscripts stdout:`, stdout);
          if (stderr) console.error(`[${requestId}] SyncAudioTranscripts stderr:`, stderr);
          resolve();
        });
      });

      // Step 4: hash and prepare JSON path for download
      requests[requestId].step = 'hash';
      console.log(`[${requestId}] Step 4: Hashing JSON...`);
      await new Promise((resolve, reject) => {
        exec(`python "${hashScript}" "${jsonPath}"`, { env }, (err, stdout, stderr) => {
          if (err) {
            console.warn(`[${requestId}] hash error:`, err);
            return reject(err);
          }
          console.log(`[${requestId}] hash output:`, stdout);
          resolve();
        });
      });

      requests[requestId].step = 'completed';
      requests[requestId].filePath = jsonPath;
      requests[requestId].done = true;
      requests[requestId].status = 'completed';
      console.log(`[${requestId}] Pipeline completed successfully.`);
    } catch (err) {
      console.error(`[${requestId}] Pipeline error:`, err.message || err);
      requests[requestId].status = 'error';
      requests[requestId].error = (err && err.message) || String(err);
    }
  })();
});

// Frontend polling endpoint for 2FA / progress
app.get('/api/2fa-status/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  res.json(info);
});

// Frontend sends OTP for a request id
app.post('/api/submit-otp/:id', (req, res) => {
  const id = req.params.id;
  const { otp } = req.body;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  info.otp = otp;
  info.status = 'otp_submitted';
  console.log(`[${id}] OTP received from frontend (masked): ${otp ? otp.replace(/\d/g,'*') : ''}`);
  res.json({ ok: true });
});

// Frontend confirms they completed a non-OTP 2FA (user pressed "I completed")
app.post('/api/confirm-2fa/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  info.userConfirmed2FA = true;
  info.status = 'user_confirmed_2fa';
  res.json({ ok: true });
});

// Internal endpoint used by the headless node script to set detected method / message
app.post('/api/internal/2fa-update/:id', (req, res) => {
  const id = req.params.id;
  const { method, message } = req.body;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  info.method = method;
  info.message = message || null;
  info.status = 'waiting_for_2fa';
  console.log(`[${id}] 2FA update from headless script:`, method, message);
  res.json({ ok: true });
});

// Internal endpoint used by headless script to poll for OTP (if frontend submitted)
app.get('/api/internal/get-otp/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  res.json({ otp: info.otp || null, userConfirmed2FA: !!info.userConfirmed2FA });
});

// Download endpoint once pipeline is complete
app.get('/api/download/:id', (req, res) => {
  const id = req.params.id;
  const info = requests[id];
  if (!info) return res.status(404).send('Not found');
  if (!info.done) return res.status(400).send('Not ready');
  const filePath = info.filePath;
  if (!filePath || !fs.existsSync(filePath)) return res.status(500).send('File not found');
  res.download(filePath);
});

const PORT = 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
