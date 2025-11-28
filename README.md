# Market Interest Index (MII) Dashboard

A comprehensive, interactive dashboard for tracking collector car market interest across manufacturers and models, based on auction data from Bring a Trailer and Cars & Bids.

## Features

### 🎯 Core Functionality
- **Real-time Market Overview**: Track key metrics across manufacturers
- **Interactive Leaderboard**: Sort and filter manufacturers by various criteria
- **Detailed Model Breakdowns**: Dive deep into individual manufacturer performance
- **Trend Visualization**: View historical MII scores over 5 quarters
- **Comparison Tool**: Compare up to 4 manufacturers side-by-side
- **Advanced Filtering**: Search, filter by auction volume, and customize views

### 📊 Key Metrics
- **MII Score**: Composite market interest index (0-100)
- **Auction Volume**: Number of auctions per manufacturer/model
- **Average Sale Price**: Mean transaction price
- **Sell-Through Rate**: Percentage of auctions that successfully sold
- **Trend**: Quarter-over-quarter percentage change
- **Confidence Level**: Data reliability indicator based on sample size

## MII Formula

The Market Interest Index is calculated using the following weighted factors:

- **Sale Price**: 30%
- **Bid Activity**: 30%
- **View Count**: 20%
- **Comments**: 12%
- **Social Engagement**: 5%
- **Vehicle Age**: 3%

## Confidence Levels

- **High** (●): 50+ auctions
- **Medium-High** (◐): 20-49 auctions
- **Medium** (◐): 10-19 auctions
- **Low** (○): 5-9 auctions

## Usage

### Running Locally

1. **Simple HTTP Server** (Python):
   ```bash
   python3 -m http.server 8080
   ```
   Then open http://localhost:8080/index.html

2. **Using Node.js** (http-server):
   ```bash
   npx http-server -p 8080
   ```
   Then open http://localhost:8080/index.html

3. **Direct File Access**:
   Simply open `index.html` in any modern web browser

### Controls & Navigation

#### Search & Filter
- **Search Box**: Type to filter manufacturers by name
- **Min Auctions**: Set minimum auction threshold (5, 10, 20, or 50)
- **Sort By**: Choose metric to sort by (MII Score, Volume, Price, Trend, Sell-Through)
- **Sort Order**: Toggle ascending/descending order

#### Manufacturer Selection
- **Click any row** in the leaderboard to view detailed breakdown
- **Model Rankings**: See all tracked models sorted by MII score
- **Trend Chart**: Visualize 5-quarter performance history

#### Comparison Mode
- **+ Button**: Add up to 4 manufacturers to comparison
- **✓ Button**: Manufacturer is selected for comparison
- **Clear All**: Remove all from comparison
- **Chart**: View overlaid trend lines for selected manufacturers

### View Modes
1. **Leaderboard**: Main ranked list view (default)
2. **Compare**: Focus on multi-manufacturer comparison
3. **Trends**: Historical trend analysis

## Technology Stack

- **HTML5**: Semantic markup
- **Tailwind CSS**: Modern, utility-first styling via CDN
- **Vanilla JavaScript**: Zero dependencies for core logic
- **Chart.js**: Interactive, responsive charts
- **No Build Process**: Works directly in browser

## Data Structure

The dashboard currently uses sample data with the following manufacturers:
- Porsche
- BMW
- Mercedes-Benz
- Ferrari
- Nissan
- Toyota
- Audi
- Chevrolet
- Ford
- Lamborghini
- Jaguar
- Land Rover

### Extending with Live Data

To integrate real auction data:

1. Replace the `sampleData` object in `app.js` with an API call
2. Ensure data follows this structure:
```javascript
{
  lastUpdated: "ISO 8601 timestamp",
  quarters: ["2024Q3", "2024Q4", ...],
  manufacturers: [
    {
      make: "Manufacturer Name",
      logo: "Emoji or URL",
      auctions: 245,
      avgPrice: 89500,
      miiScore: 87.4,
      confidence: "High",
      trend: 4.2,
      sellThrough: 78,
      history: [82.1, 83.5, 85.2, 86.8, 87.4],
      models: [...]
    }
  ]
}
```

## Files

- `index.html` - Main dashboard HTML structure
- `app.js` - Application logic, data management, and rendering
- `app.py` - Legacy Streamlit Python scraper (deprecated)
- `requirements.txt` - Python dependencies for legacy app

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- All modern browsers with ES6+ support

## Future Enhancements

- [ ] Real-time data integration via API
- [ ] Export functionality (CSV, PDF)
- [ ] User preferences persistence (localStorage)
- [ ] Mobile-responsive optimizations
- [ ] Additional chart types (scatter, heat maps)
- [ ] Bookmark/favorite manufacturers
- [ ] Price range filtering
- [ ] Time period customization

## License

© 2025 Market Interest Index

## Contributing

To contribute or report issues, please contact the repository maintainer.
