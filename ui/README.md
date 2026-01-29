# Clodds UI Components

Shared UI components and design system for Clodds applications.

## Structure

```
ui/
├── components/       # Reusable components
│   ├── Button/
│   ├── Card/
│   ├── Chart/
│   ├── Input/
│   ├── Modal/
│   └── Table/
├── hooks/            # Shared React hooks
├── styles/           # CSS/Tailwind styles
├── themes/           # Theme definitions
└── utils/            # UI utilities
```

## Components

### Market Components
- `MarketCard` - Display market info
- `PriceChart` - Historical price chart
- `OrderBook` - Live orderbook display
- `PositionTable` - Portfolio positions

### Alert Components
- `AlertBadge` - Alert notification
- `AlertList` - Alert management
- `AlertForm` - Create/edit alerts

### Common Components
- `Button` - Action buttons
- `Input` - Form inputs
- `Modal` - Dialog modals
- `Toast` - Notifications

## Usage

```tsx
import { MarketCard, PriceChart } from '@clodds/ui';

function MarketView({ market }) {
  return (
    <div>
      <MarketCard market={market} />
      <PriceChart data={market.priceHistory} />
    </div>
  );
}
```
