import React, { useState, useEffect } from "react";
import { Link } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';


const TreeNode = ({ node, depth = 0, onFileClick, selectedFile }) => {
  const [open, setOpen] = useState(depth < 2);

  if (!node) return null;

  if (node.type === "folder") {
    return (
      <div style={{ marginLeft: `${depth * 16}px` }}>
        <div
          style={{
            cursor: "pointer",
            color: "#02f813ff",
            padding: "2px 0",
            userSelect: "none",
            display: "flex",
            alignItems: "center",
            fontFamily: "'Orbitron', sans-serif"
          }}
          onClick={() => setOpen(!open)}
        >
          <span style={{ marginRight: "8px" }}>
            {open ? "📂" : "📁"}
          </span>
          <span>
            {node.name}
            {node.children && ` (${node.children.length})`}
            {node.error && " ❌"}
            {node.partial && " ⚠️"}
          </span>
        </div>
        {open && node.children && (
          <div>
            {node.children.map((child, i) => (
              <TreeNode 
                key={`${child.name}-${i}`} 
                node={child} 
                depth={depth + 1}
                onFileClick={onFileClick}
                selectedFile={selectedFile}
              />
            ))}
          </div>
        )}
        {node.error && (
          <div style={{ color: "#ff6b6b", marginLeft: "20px", fontSize: "12px" }}>
            Error: {node.error}
          </div>
        )}
      </div>
    );
  }

  // File node - make it clickable
  const isSelected = selectedFile && selectedFile.path === node.path;
  return (
    <div 
      style={{ 
        marginLeft: `${depth * 16}px`, 
        color: isSelected ? "#00bcd4" : "#eee", 
        padding: "2px 0",
        fontFamily: "monospace",
        display: "flex",
        alignItems: "center",
        cursor: "pointer",
        background: isSelected ? "#2a2a2a" : "transparent",
        borderRadius: "4px",
        paddingLeft: "8px"
      }}
      onClick={() => onFileClick(node)}
    >
      <span style={{ marginRight: "8px", fontFamily: "'Orbitron', sans-serif"}}>📄</span>
      <span style={{ 
      fontFamily: "'Orbitron', monospace, sans-serif",  // ✅ APPLY FONT TO NAME
      fontWeight: "500"
    }}>
      {node.name}
    </span>
      {isSelected && " 🔍"}
    </div>
  );
};

  const FileContentViewer = ({ file, onClose }) => {
    const [content, setContent] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const loadFileContent = async () => {
      if (!file) return;
      
      setLoading(true);
      setError(null);
      setContent(null);
      
      try {
        console.log(`📄 Loading file content for: ${file.path}`);
        
        // ✅ ADD THIS PARAMETER to get the actual file content
        const response = await fetch(
          `http://localhost:5000/api/file-preview?path=${file.path}&include_content=true`
        );
        
        if (!response.ok) {
          throw new Error(`Server returned ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('📦 File content response:', data);
        
        if (data.error) {
          throw new Error(data.error);
        }
        
        setContent(data);
        
      } catch (err) {
        console.error('❌ Error loading file content:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

  useEffect(() => {
    if (file) {
      loadFileContent();
    }
  }, [file]);


  if (!file) return null;

  // Determine file type
  const cleanFileName = file.name.replace(/\r/g, '').trim();
  const fileExt = cleanFileName.includes('.') ? '.' + cleanFileName.split('.').pop().toLowerCase() : '';

  // Use both MIME type and file extension for detection
  const isImage = content?.mimeType?.startsWith('image/') || 
                  ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(fileExt);

  const isText = ['.txt', '.json', '.xml', '.html', '.css', '.js', '.log', '.md', '.csv'].includes(fileExt);
  const isAudio = content?.mimeType?.startsWith('audio/') ||
                  ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(fileExt);

  console.log("Is it an image?",isImage);
  console.log("Is it an audio?",isAudio);
  return (
    <div style={{
      background: "#2d2d2d",
      border: "3px solid #06fb02ff",
      borderRadius: "8px",
      padding: "16px",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      transition: "all 0.2s ease"  
    }}>
      {/* Header */}
      <div style={{ 
        display: "flex", 
        justifyContent: "space-between", 
        alignItems: "center",
        marginBottom: "16px",
        borderBottom: "1px solid #444",
        paddingBottom: "12px"
      }}>
        <div style={{ fontWeight: "bold", color: "#00ff1eff", fontSize: "16px" }}>
          📄 <span style={{ 
              fontFamily: "'Orbitron', monospace, sans-serif",  // ✅ APPLY FONT TO NAME
              fontWeight: "500"
            }}>
              {file.name}
            </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "#666",
            border: "none",
            color: "#fff",
            padding: "6px 12px",
            borderRadius: "4px",
            fontSize: "12px",
            cursor: "pointer"
          }}
        >
          Close
        </button>
      </div>

      {/* Loading State */}
      {loading && (
        <div style={{ textAlign: "center", padding: "40px", color: "#04ff00ff", flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontSize: "14px" }}>Loading file content...</div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div style={{ 
          color: "#ff6b6b", 
          textAlign: "center", 
          padding: "20px",
          background: "#3a2a2a",
          borderRadius: "4px",
          marginBottom: "16px"
        }}>
          <div style={{ fontSize: "16px", marginBottom: "8px" }}>❌ Failed to load file</div>
          <div style={{ fontSize: "12px", color: "#ff9999" }}>Error: {error}</div>
          <button 
            onClick={() => window.location.reload()}
            style={{
              marginTop: "10px",
              background: "#555",
              border: "none",
              color: "#fff",
              padding: "5px 10px",
              borderRadius: "4px",
              cursor: "pointer"
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Content Display */}
      {content && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          {/* File Info */}
          <div style={{ 
            color: "#aaa", 
            fontSize: "12px", 
            marginBottom: "12 px",
            display: "flex",
            gap: "16px",
            flexWrap: "wrap"
          }}>
          </div>

          {/* Content Display Area */}
          <div style={{ 
            background: "#1a1a1a",
            borderRadius: "6px",
            padding: "16px",
            flex: 1,
            overflow: "auto",
            border: "1px solid #333"
          }}>
            {/* Text File Display */}
            {isText && content.content && (
              <pre style={{ 
                margin: 0, 
                color: "#e0e0e0",
                whiteSpace: "pre-wrap",
                wordWrap: "break-word",
                fontFamily: "'Monaco', 'Menlo', 'Ubuntu Mono', monospace",
                lineHeight: "1.5",
                fontSize: "13px"
              }}>
                {content.content}
              </pre>
            )}

            {/* Image File Display */}
            {isImage && content && content.content && (
              <div style={{ textAlign: "center" }}>
                <img 
                  src={`data:${content.mimeType};base64,${content.content}`}
                  alt={file.name}
                  style={{ 
                    maxWidth: "100%", 
                    maxHeight: "400px",
                    borderRadius: "4px",
                    border: "1px solid #444"
                  }}
                  onError={(e) => {
                    console.error('❌ Image failed to load from base64');
                    e.target.style.display = 'none';
                  }}
                  onLoad={() => console.log('✅ Image loaded successfully from base64')}
                />
              </div>
            )}

            {/* Audio File Display */}
            {isAudio && content && content.content && (
              <div style={{ textAlign: "center", padding: "20px" }}>
                <div style={{ color: "#aaa", fontSize: "12px", marginBottom: "12px" }}>
                  Audio Player ({content.mimeType || 'audio/mpeg'})
                </div>
                
                <audio 
                  controls 
                  style={{ 
                    width: "100%", 
                    maxWidth: "400px",
                    marginBottom: "16px"
                  }}
                  onError={(e) => console.error('❌ Audio failed to load:', e)}
                  onCanPlay={() => console.log('✅ Audio can play now')}
                >
                  <source 
                    src={`data:${content.mimeType || 'audio/mpeg'};base64,${content.content}`} 
                    type={content.mimeType || 'audio/mpeg'}
                  />
                  Your browser does not support the audio element.
                </audio>
                
                <button
                  onClick={() => {
                    const byteCharacters = atob(content.content);
                    const byteNumbers = new Array(byteCharacters.length);
                    for (let i = 0; i < byteCharacters.length; i++) {
                      byteNumbers[i] = byteCharacters.charCodeAt(i);
                    }
                    const byteArray = new Uint8Array(byteNumbers);
                    const blob = new Blob([byteArray], { type: content.mimeType || 'audio/mpeg' });
                    
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(blob);
                    link.download = file.name;
                    link.click();
                    URL.revokeObjectURL(link.href);
                  }}
                  style={{
                    background: "#444",
                    border: "none",
                    color: "#1dfb00ff",
                    padding: "8px 16px",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "12px"
                  }}
                >
                  Download Audio
                </button>
              </div>
            )}

            {/* Binary File Display */}
            {!isText && !isImage && !isAudio && content.content && (
              <div style={{ textAlign: "center", color: "#aaa", padding: "20px" }}>
                <div style={{ fontSize: "24px", marginBottom: "12px" }}>📦</div>
                <div style={{ fontSize: "14px", marginBottom: "8px" }}>
                  Binary File ({content.mimeType || fileExt})
                </div>
                <div style={{ fontSize: "12px", color: "#888", marginBottom: "16px" }}>
                  Content loaded as base64 ({content.content.length} characters)
                </div>
                <button
                  onClick={() => {
                    const byteCharacters = atob(content.content);
                    const byteNumbers = new Array(byteCharacters.length);
                    for (let i = 0; i < byteCharacters.length; i++) {
                      byteNumbers[i] = byteCharacters.charCodeAt(i);
                    }
                    const byteArray = new Uint8Array(byteNumbers);
                    const blob = new Blob([byteArray], { type: content.mimeType });
                    
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(blob);
                    link.download = file.name;
                    link.click();
                    URL.revokeObjectURL(link.href);
                  }}
                  style={{
                    background: "#444",
                    border: "none",
                    color: "#fff",
                    padding: "8px 16px",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "12px"
                  }}
                >
                  Download File
                </button>
              </div>
            )}

            {/* No Content Available */}
            {!content.content && (
              <div style={{ textAlign: "center", color: "#ff6b6b", padding: "20px" }}>
                <div style={{ fontSize: "16px", marginBottom: "8px" }}>❌ No content available</div>
                <div style={{ fontSize: "12px", color: "#ff9999" }}>
                  Server returned no file content.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* No content state */}
      {!loading && !error && !content && (
        <div style={{ textAlign: "center", color: "#aaa", padding: "40px", flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontSize: "14px" }}>File content will appear here when loaded...</div>
        </div>
      )}
    </div>
  );
};

export const FileSystem = () => {
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState({ current: "", total: "", status: "" });
  const [selectedFile, setSelectedFile] = useState(null);
    const navigate = useNavigate();

  // ✅ ADD THESE: Button styles
  const bigButtonStyle = {
    background: "#00ff1a",
    border: "2px solid #00ff1a",
    color: "#000",
    padding: "12px 24px",
    borderRadius: "8px",
    fontSize: "16px",
    cursor: "pointer",
    fontWeight: "bold",
    fontFamily: "'Orbitron', sans-serif",
    marginTop: "20px",
    transition: "all 0.3s ease"
  };

  const bigButtonHover = {
    background: "#00cc15",
    borderColor: "#00cc15",
    scale: 1.05
  };
  useEffect(() => {
    const fetchFileSystem = async () => {
      try {
        setLoading(true);
        setError(null);
        setProgress({ status: "Connecting to device..." });

        const response = await fetch("http://localhost:5000/api/filesystem");
        
        if (!response.ok) {
          setProgress({ status: "Direct method failed, trying recursive pull..." });
          await fetchRecursiveFileSystem();
        } else {
          const data = await response.json();
          setTree(data);
          setProgress({ status: "Complete!" });
        }
      } catch (err) {
        console.error("Error fetching filesystem:", err);
        setError(err.message);
        setProgress({ status: "Failed" });
      } finally {
        setLoading(false);
      }
    };

    const fetchRecursiveFileSystem = async () => {
      try {
        setProgress({ status: "Starting recursive folder scan..." });
        
        const foldersResponse = await fetch("http://localhost:5000/api/scan-folders");
        const folders = await foldersResponse.json();
        
        setProgress({ 
          status: `Found ${folders.length} top-level folders`, 
          total: folders.length 
        });

        const root = { 
          name: "sdcard", 
          type: "folder", 
          children: [] 
        };

        for (let i = 0; i < folders.length; i++) {
          const folder = folders[i];
          setProgress({ 
            current: folder, 
            total: folders.length,
            status: `Scanning ${folder}... (${i + 1}/${folders.length})`
          });

          try {
            const folderData = await fetchFolderContents(folder);
            root.children.push(folderData);
          } catch (folderError) {
            console.error(`Error scanning folder ${folder}:`, folderError);
            root.children.push({
              name: folder,
              type: "folder",
              error: folderError.message,
              partial: true,
              children: []
            });
          }

          await new Promise(resolve => setTimeout(resolve, 100));
        }

        setTree(root);
        setProgress({ status: "Scan complete!" });
      } catch (err) {
        throw new Error(`Recursive scan failed: ${err.message}`);
      }
    };

    const fetchFolderContents = async (folderPath) => {
      const response = await fetch(`http://localhost:5000/api/scan-folder?path=${encodeURIComponent(folderPath)}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    };

    fetchFileSystem();
  }, []);

  const handleFileClick = (fileNode) => {
    if (selectedFile && selectedFile.path === fileNode.path) {
      setSelectedFile(null);
    } else {
      setSelectedFile(fileNode);
    }
  };

  if (loading) return (
    <div style={{ background: "#111", color: "#fff", padding: "20px", minHeight: "100vh" }}>
      <h2 style={{ color: "#09ff00ff", marginBottom: "20px", fontFamily: "'Orbitron', sans-serif"}}>📱 Smartwatch Filesystem</h2>
      <div style={{ color: "#aaa", marginBottom: "20px" }}>
        <p>Loading filesystem...</p>
        {progress.status && (
          <div style={{ 
            background: "#333", 
            padding: "10px", 
            borderRadius: "4px", 
            marginTop: "10px",
            fontSize: "14px"
          }}>
            <div>{progress.status}</div>
            {progress.current && (
              <div style={{ marginTop: "5px" }}>
                Current: <strong>{progress.current}</strong>
                {progress.total && ` (${progress.total} total)`}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (error) return (
    <div style={{ background: "#111", color: "#fff", padding: "20px", minHeight: "100vh" }}>
      <h2 style={{ color: "#00ff11ff", marginBottom: "20px", fontFamily: "'Orbitron', sans-serif"}}>📱 Smartwatch Filesystem</h2>
      <div style={{ color: "#f44336", marginBottom: "20px" }}>
        <p><strong>Error:</strong> {error}</p>
      </div>
      <div style={{ color: "#aaa", fontSize: "14px" }}>
        <p>Possible issues:</p>
        <ul style={{ marginLeft: "20px" }}>
          <li>Smartwatch not connected via USB</li>
          <li>USB debugging not enabled</li>
          <li>ADB device not authorized</li>
          <li>Server not running on port 5000</li>
        </ul>
      </div>
    </div>
  );

  if (!tree) return (
    <div style={{ background: "#111", color: "#fff", padding: "20px", minHeight: "100vh" }}>
      <h2 style={{ color: "#00ff1aff", marginBottom: "20px", fontFamily: "'Orbitron', sans-serif" }}>📱 Smartwatch Filesystem</h2>
      <p style={{ color: "#f44336" }}>No filesystem data received</p>
    </div>
  );

  return (
    <div style={{ 
      background: "#111", 
      color: "#fff", 
      padding: "20px", 
      fontFamily: "Arial, sans-serif",
      minHeight: "100vh" 
    }}>
      <h2 style={{ color: "#00ff1aff", marginBottom: "20px", fontFamily: "'Orbitron', sans-serif" }}>📱 Smartwatch Filesystem</h2>
      
      {progress.status && progress.status !== "Complete!" && (
        <div style={{ 
          background: "#333", 
          padding: "10px", 
          borderRadius: "4px", 
          marginBottom: "20px",
          fontSize: "14px"
        }}>
          {progress.status}
        </div>
      )}

      {/* ✅ CHANGED: Flex container with file viewer on RIGHT */}
      <div style={{ 
        display: "flex",
        gap: "20px",
        height: "70vh"
      }}>
        {/* Folder Tree - LEFT SIDE */}
        <div style={{ 
          flex: selectedFile ? "1" : "1",
          background: "#1a1a1a", 
          padding: "20px", 
          borderRadius: "8px",
          border: "1px solid #333",
          overflow: "auto"
        }}>
          <TreeNode 
            node={tree} 
            onFileClick={handleFileClick}
            selectedFile={selectedFile}
          />
        </div>

        {/* File Viewer - RIGHT SIDE */}
        {selectedFile && (
          <div style={{ 
            flex: "1",
            minWidth: "400px"
          }}>
            <FileContentViewer 
              file={selectedFile} 
              onClose={() => setSelectedFile(null)}
            />
          </div>
        )}
      </div>
      <motion.button
          onClick={() => navigate('/smartwatch')}
          style={bigButtonStyle}
          whileHover={bigButtonHover}
        >
          Back to SmartWatch
        </motion.button>
    </div>
  );
};

export default FileSystem;