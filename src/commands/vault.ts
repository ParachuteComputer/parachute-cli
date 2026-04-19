export async function dispatchVault(args: readonly string[]): Promise<number> {
  try {
    const proc = Bun.spawn(["parachute-vault", ...args], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await proc.exited;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("enoent") || msg.toLowerCase().includes("not found")) {
      console.error("parachute-vault not found on PATH.");
      console.error("Install it with: parachute install vault");
      return 127;
    }
    console.error(`failed to run parachute-vault: ${msg}`);
    return 1;
  }
}
