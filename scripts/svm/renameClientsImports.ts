/// <reference types="node" />
/**
 * Post-processes generated Codama clients to replace @solana/web3.js imports with @solana/kit.
 * This is needed because Codama generates imports for @solana/web3.js by default.
 */
import fs from "fs";
import path from "path";

const clientsPath = path.join(__dirname, "..", "..", "src", "svm", "clients");

function replaceInFiles(dir: string): void {
  const files = fs.readdirSync(dir);
  files.forEach((file: string) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      replaceInFiles(filePath);
    } else if (file.endsWith(".ts")) {
      const fileContent = fs.readFileSync(filePath, "utf8");
      const updatedContent = fileContent.replace("@solana/web3.js", "@solana/kit");
      fs.writeFileSync(filePath, updatedContent);
    }
  });
}

replaceInFiles(clientsPath);
console.log("Client imports renamed (@solana/web3.js -> @solana/kit)");
