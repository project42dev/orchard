import { writeFileSync } from "node:fs";

export function writeControllerResult({ result, mode, outputPath, write = writeFileSync, stdout = process.stdout }) {
    const output = `${JSON.stringify(result, null, 2)}\n`;
    if (mode === "dry-run") {
        stdout.write(output);
        return { destination: "stdout", bytes: Buffer.byteLength(output) };
    }
    if (typeof outputPath !== "string" || outputPath.length < 1) throw new TypeError("non-dry controller output requires --out");
    write(outputPath, output, "utf8");
    return { destination: "file", bytes: Buffer.byteLength(output) };
}
