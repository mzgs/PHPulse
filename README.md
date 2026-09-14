# PHPulse — PHP Tools

PHPulse provides advanced PHP and Laravel development tools for Visual Studio Code. It combines native editor providers with standard PHP ecosystem tools, so projects remain portable and there is no proprietary runtime or telemetry.

## Features

- Workspace-aware completion, automatic imports, PHPDoc tags, signatures, hover help, and links to the PHP manual.
- Go to definition and implementation, find references, document highlights, workspace rename, breadcrumbs, outline, workspace symbols, folding, call hierarchy, and type hierarchy.
- PHPDoc generation, unused-import diagnostics and fixes, extract-variable and extract-constant refactoring, getter/setter generation, reference CodeLens, and parameter-name inlay hints.
- Continuous `php -l` validation, compatibility hints, TODO highlighting, and PHPStan or Psalm integration when installed through Composer.
- Document, selection, on-type, on-save, and batch formatting using a conservative PSR-style layout.
- Laravel Blade highlighting, directive completion, view/component discovery, route names, configuration keys, model columns, embedded-language scopes, snippets, and formatting.
- PHPUnit and Pest discovery in VS Code's Test Explorer, individual execution, debugging, result output, and optional continuous testing.
- PHP development-server commands, Composer installation, and an Xdebug launch configuration through the maintained `xdebug.php-debug` extension.

## Requirements

- Visual Studio Code 1.96 or newer
- Node.js and npm for extension development
- PHP available on `PATH` for linting and development-server features
- Optional: Composer, PHPStan or Psalm, PHPUnit or Pest, and Xdebug

## Development

Clone the repository and run:

```bash
./install.sh
```

The script installs dependencies, type-checks the project, packages the extension, and force-installs the current VSIX. Reload the VS Code window afterward.

To use a specific compatible editor CLI:

```bash
VSCODE_CLI=code-insiders ./install.sh
VSCODE_CLI=cursor ./install.sh
```

For an isolated development session, run `npm install`, open the repository in VS Code, and press `F5` to launch the Extension Development Host.

Useful commands:

```bash
npm run lint       # Type-check without emitting files
npm run compile    # Compile TypeScript into dist/
npm run watch      # Compile continuously
npm run package    # Produce a VSIX package
```

## PHPulse commands

- `PHPulse: Reindex Workspace`
- `PHPulse: Analyze Workspace`
- `PHPulse: Format Workspace`
- `PHPulse: Start PHP Development Server`
- `PHPulse: Stop PHP Development Server`
- `PHPulse: Generate PHPDoc`
- `PHPulse: Remove Unused Imports`
- `PHPulse: Open PHP Manual for Symbol`
- `PHPulse: Create Debug Configuration`
- `PHPulse: Composer Install`

## Optional project tools

For deeper static analysis, install either `phpstan/phpstan` or `vimeo/psalm`. Tests are detected from `tests/` and `test/`; PHPUnit or Pest should normally be available in `vendor/bin`. Xdebug 3 listens on port `9003` by default.

## Capability notes

PHPulse is an independent implementation. It does not copy proprietary code, semantic engines, private AI models, or branded integrations. Advanced inference uses standard PHPDoc, PHPStan, and Psalm metadata; debugging uses Xdebug.

## License

MIT
