import readline from 'node:readline';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code: string, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const ok = (text: string): void => console.log(`${paint('32', '✓')} ${text}`);
export const warn = (text: string): void => console.log(`${paint('33', '!')} ${text}`);
export const fail = (text: string): void => console.log(`${paint('31', '✗')} ${text}`);
export const info = (text: string): void => console.log(`  ${text}`);
export const heading = (text: string): void => console.log(`\n${paint('1', text)}`);

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${question}${suffix}: `, resolve);
  });
  rl.close();
  const trimmed = answer.trim();
  return trimmed || defaultValue || '';
}

export async function confirm(question: string, defaultValue = false): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await prompt(`${question} [${hint}]`)).toLowerCase();
  if (!answer) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

export async function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const holder = rl as unknown as {
      _writeToOutput?: (text: string) => void;
      output: NodeJS.WriteStream;
    };
    const original = holder._writeToOutput;
    let muted = false;
    holder._writeToOutput = (text: string) => {
      if (muted) return;
      original?.call(rl, text);
    };
    rl.question(question, (answer) => {
      rl.close();
      holder.output.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

export function table(rows: string[][]): void {
  if (rows.length === 0) return;
  const widths = rows[0].map((_, index) =>
    Math.max(...rows.map((row) => (row[index] || '').length)),
  );
  for (const row of rows) {
    console.log(
      `  ${row
        .map((cell, index) => (cell || '').padEnd(widths[index]))
        .join('  ')
        .trimEnd()}`,
    );
  }
}
