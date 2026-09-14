# PHPulse — PHP Tools

PHPulse provides advanced PHP and Laravel development tools for Visual Studio Code. It combines native editor providers with standard PHP ecosystem tools, so projects remain portable and there is no proprietary runtime or telemetry.

## Features

- Type-aware completion with scoped variables, inherited members, chained calls, safe automatic imports, PHPDoc tags, signatures, hover help, and links to the PHP manual.
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
npm test           # Compile and run semantic and completion regression tests
npm run benchmark  # Measure indexing and completion on a synthetic PHP workspace
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

## Smart IntelliSense

PHPulse shares a tolerant, token-based PHP model between completion, hover, go to definition, and signature help. It understands multiline declarations, namespace aliases and grouped imports, constructor-promoted properties, inheritance, and trait members. Comments, quoted strings, and heredocs do not create spurious declarations.

- Member suggestions follow parameter and property types, recent assignments, function/method return types, and `@param`, `@var`, and `@return` annotations. Chained calls, `?->`, `self`, `static`, `parent`, typed array elements, and `foreach` values retain their types.
- Local suggestions respect function and closure scopes. Positive braced `instanceof` branches narrow the receiver type. Unknown receivers produce no speculative member list.
- Instance and static access filter members by visibility. Workspace types support prefix and camel-case matching, and imports respect aliases, name collisions, the active namespace, and `declare(strict_types=1)`.
- Method/function suggestions insert required argument placeholders and open parameter hints. Existing parentheses and `$` prefixes are preserved. Signature help handles nested arguments and named parameters.
- Unsaved buffers are analyzed when a suggestion is requested. File watching keeps the index current after external changes. Composer `vendor/` sources are indexed by default; add `**/vendor/**` to `phpulse.index.exclude` to opt out. Existing explicit exclusions remain in effect. The workspace index currently scans up to 15,000 PHP files.

Edits update only the changed file's symbol entries. Completion uses name/prefix indexes and direct import-collision lookups; function scopes and their tokens are cached per document revision. Editor symbols are created on demand and reused for unchanged files. See [benchmark methodology and sample results](benchmark/README.md) for measured performance and limits.

For example, given a declared `User::address(): Address`, completion after `$user?->address()->` offers accessible `Address` members, and go to definition resolves the method on `User` even when another class has a method with the same name.

This is a lightweight semantic engine, not full IntelliJ/PhpStorm parity. Arbitrary control-flow merging, general template/generic substitution, runtime magic members and Laravel container/facade resolution, anonymous classes, and a complete PHP standard-library symbol database remain outside its current inference coverage. Blade-specific directives and Laravel string suggestions continue through their dedicated provider. The automated suite exercises the analysis engine and editor-provider edits with a VS Code API test double; interactive editor behavior can be checked in the Extension Development Host.

## Capability notes

PHPulse is an independent implementation. It does not copy proprietary code, semantic engines, private AI models, or branded integrations. IntelliSense uses native PHP declarations and standard PHPDoc types. PHPStan and Psalm provide optional diagnostics; debugging uses Xdebug.

## License

MIT
