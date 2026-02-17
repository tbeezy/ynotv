const { execSync } = require('child_process');
const process = require('process');

function killPort(port) {
  try {
    if (process.platform === 'win32') {
      // Windows
      try {
        const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
        const lines = result.split('\n').filter(line => line.includes('LISTENING'));
        
        lines.forEach(line => {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && !isNaN(parseInt(pid))) {
            console.log(`Killing process ${pid} on port ${port}`);
            try {
              execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
            } catch (e) {
              // Process might already be dead
            }
          }
        });
      } catch (e) {
        // No process found on port
      }
    } else {
      // macOS/Linux
      try {
        execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' });
        console.log(`Killed processes on port ${port}`);
      } catch (e) {
        // No process found
      }
    }
  } catch (e) {
    console.error(`Error killing port ${port}:`, e.message);
  }
}

// Kill common dev ports
console.log('Cleaning up dev processes...');
killPort(5173);  // Vite dev server
killPort(1420);  // Tauri dev server (default)
console.log('Done! You can now run `pnpm dev`');
