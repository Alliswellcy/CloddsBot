# Clodds Assets

Static assets for Clodds applications.

## Structure

```
assets/
├── icons/            # App icons
│   ├── icon.png      # 1024x1024 base icon
│   ├── icon-16.png   # Favicon
│   ├── icon-32.png   # Small icon
│   ├── icon-64.png   # Medium icon
│   ├── icon-128.png  # Large icon
│   ├── icon-256.png  # XL icon
│   └── icon-512.png  # XXL icon
├── logos/            # Brand logos
│   ├── logo.svg      # Vector logo
│   ├── logo-dark.svg # Dark mode logo
│   └── wordmark.svg  # Logo with text
├── images/           # Static images
│   ├── og-image.png  # Open Graph image
│   └── splash.png    # Splash screen
└── fonts/            # Custom fonts
    └── Inter/        # Inter font family
```

## Usage

Assets are bundled with apps during build. Reference them using the `@clodds/assets` package:

```tsx
import logo from '@clodds/assets/logos/logo.svg';
import icon from '@clodds/assets/icons/icon-64.png';
```
