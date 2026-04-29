# RouteOptimizer - CSV Upload Guide

## CSV File Format

Your CSV file must contain the following columns:

### Required Columns:

1. **distance** (float)
   - Distance in kilometers
   - Example: `10.5`, `15.2`

2. **traffic_level** (integer, 1-5)
   - Traffic congestion level
   - 1 = Very light traffic
   - 5 = Heavy traffic
   - Example: `1`, `3`, `5`

3. **delivery_time** (float)
   - Estimated delivery time in minutes
   - Example: `25`, `35.5`

4. **weather_condition** (integer, 0-2)
   - 0 = Clear weather
   - 1 = Rainy
   - 2 = Stormy
   - Example: `0`, `1`, `2`

5. **lat** (float)
   - Latitude coordinate
   - Example: `12.9716`, `13.0358`

6. **lng** (float)
   - Longitude coordinate
   - Example: `77.5946`, `77.6271`

### Optional Column:

- **id** (integer)
  - Unique delivery identifier
  - Auto-generated if not provided

## Example CSV

```csv
distance,traffic_level,delivery_time,weather_condition,lat,lng
10.5,2,25,0,12.9716,77.5946
15.2,4,35,1,12.9279,77.6271
8.3,5,45,2,12.9925,77.5862
```

## How to Use

1. **Prepare your CSV file** with the required columns
2. **Open the application** at http://localhost:5173
3. **Click "Upload CSV File"** in the sidebar
4. **Select your CSV file**
5. The system will:
   - ✅ Validate the file format
   - ✅ Calculate risk scores for each delivery
   - ✅ Optimize the route using Genetic Algorithm
   - ✅ Display results on the map with risk analysis

## Sample File

A sample CSV file (`sample_deliveries.csv`) is included in the project root for testing.

## API Endpoint

You can also upload CSV files directly to the API:

```bash
curl -X POST http://127.0.0.1:8000/upload_csv \
  -F "file=@sample_deliveries.csv"
```

## Error Messages

- **Missing columns**: Ensure all required columns are present
- **Invalid format**: Check that values match the expected types
- **Empty file**: File must contain at least one data row

## Features

✨ **Automatic Risk Prediction** - ML model predicts delivery risk  
🧬 **Genetic Algorithm Optimization** - Finds the optimal route  
🗺️ **Interactive Map Visualization** - See your route on the map  
📊 **Risk Analysis Dashboard** - Detailed risk metrics for each stop
