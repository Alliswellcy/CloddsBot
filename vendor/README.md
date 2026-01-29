# Clodds Vendor

Vendored dependencies and third-party code.

## Purpose

This directory contains:
- Patched versions of npm packages
- Native binaries
- Bundled tools that aren't available via npm

## Structure

```
vendor/
├── patches/          # Patch files for npm packages
│   └── some-pkg+1.0.0.patch
├── binaries/         # Platform-specific binaries
│   ├── darwin-arm64/
│   ├── darwin-x64/
│   ├── linux-arm64/
│   ├── linux-x64/
│   └── win32-x64/
└── tools/            # Bundled tools
    └── some-tool/
```

## Patch Format

Patches are applied using `patch-package`:

```bash
# Create a patch
npx patch-package some-pkg

# Apply patches
npx patch-package
```

## License

Each vendored package retains its original license. See individual directories for license information.
