const { spawn, exec } = require('child_process');

async function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    // if this is a binary (not a shell command like "kill ...")
    const isBinary = !command.startsWith("kill ") && !command.includes(" ");

    if (isBinary) {
      // start detached background process
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
      });

      if (!child.pid) {
        reject(new Error("Failed to spawn process"));
        return;
      }

      console.log(`Spawned process PID: ${child.pid}`);
      child.unref(); // allow parent to exit independently

      resolve(child.pid);
    } else {
      // run shell command (like "kill 1234")
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error("Command failed:", error.message);
          reject(error);
          return;
        }
        if (stderr) console.warn("Command stderr:", stderr);
        resolve(stdout.trim());
      });
    }
  });
}

module.exports = { runCommand };
