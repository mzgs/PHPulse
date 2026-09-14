import * as vscode from 'vscode';
import { PhpIndex } from './model';
import { registerLanguageFeatures } from './providers';
import { Diagnostics, PhpTests, registerBladeFeatures, registerCommands } from './tooling';

let index: PhpIndex | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<{ symbolCount: () => number }> {
  const output = vscode.window.createOutputChannel('PHPulse');
  context.subscriptions.push(output);
  output.appendLine('Activating PHPulse…');

  index = new PhpIndex();
  const diagnostics = new Diagnostics(output);
  const tests = new PhpTests(output);
  context.subscriptions.push(index, diagnostics, tests);

  registerLanguageFeatures(context, index);
  registerBladeFeatures(context);
  registerCommands(context, index, diagnostics, output);

  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('php', {
    resolveDebugConfiguration(_folder, config) {
      if (!config.type && !config.request && !config.name) config = { type: 'php', name: 'Listen for Xdebug', request: 'launch', port: 9003 };
      if (config.type === 'php' && config.request === 'launch' && !config.port) config.port = 9003;
      return config;
    }
  }));

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'PHP: indexing workspace' }, async () => index!.initialize());
  output.appendLine(`Ready. Indexed ${index.all().length} PHP symbols.`);
  return { symbolCount: () => index?.all().length ?? 0 };
}

export function deactivate(): void { index?.dispose(); index = undefined; }
