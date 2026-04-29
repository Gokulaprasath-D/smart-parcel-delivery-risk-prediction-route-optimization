# Smart Parcel Delivery Risk Prediction & Route Optimization System

## Overview
This system is an intelligent logistics management platform designed to predict delivery failure risks and optimize last-mile routing using machine learning and advanced algorithms. It is specifically tailored for operations in Tamil Nadu, India.

## Key Modules

### 1. Delivery Risk Prediction Module
- **Models**: Random Forest Classifier and Logistic Regression.
- **Features**: Includes engineered features like delivery day, distance deviation, and order deviation.
- **Functionality**: Returns a risk class (High, Medium, Low) and failure probability for each order.

### 2. Nearby Delivery Clustering Module
- **Algorithm**: DBSCAN (Density-Based Spatial Clustering of Applications with Noise).
- **Purpose**: Groups deliveries into geographical clusters to minimize cross-city travel and improve operation efficiency.

### 3. Dynamic Route Optimization Module
- **Algorithm**: Genetic Algorithm (GA).
- **Behavior**: Optimizes sequences within clusters by minimizing travel distance while prioritizing high-risk deliveries.
- **Adaptability**: Supports real-time re-routing as new orders are added.

### 4. Interactive Visualization Module
- **Frontend**: React.js with `framer-motion` for animations.
- **Mapping**: React-Leaflet with OpenStreetMap (Dark Mode tiles).
- **Decision Support**: High-risk points are visually highlighted (red markers/glow), and clusters are clearly identifiable.

## How to Use

1. **Start Backend**: `python -m uvicorn backend.main:app --port 8000`
2. **Start Frontend**: `npm run dev` in the `client` folder.
3. **Upload Data**: Use the "Upload CSV" button to load `sample_deliveries.csv`.
4. **View Results**: The map will center on Tamil Nadu, showing clustered markers and the optimized route polyline.

## CSV Input Format
The system expects a CSV with the following columns:
- `distance`, `traffic_level`, `delivery_time`, `weather_condition`, `lat`, `lng`
- Optional: `delivery_day`, `distance_deviation`, `order_deviation`
