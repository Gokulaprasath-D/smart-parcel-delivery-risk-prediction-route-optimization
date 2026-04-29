# Machine Learning Model Training Guide

## Overview
This project uses a RandomForestClassifier to predict delivery risk levels (Low, Medium, High) based on delivery parameters.

## Model Performance
- **Accuracy**: 99%
- **Algorithm**: Random Forest Classifier
- **Features**: 4 (distance, traffic_level, delivery_time, weather_condition)
- **Target**: risk_level (categorical: Low/Medium/High)

## Training Process

### 1. Data Preparation
The training data is located at: `backend/data/delivery_data.csv`

**Required Columns:**
- `distance` (float): Delivery distance in kilometers
- `traffic_level` (int): Traffic level (1-5)
- `delivery_time` (float): Delivery time in minutes
- `weather_condition` (int): 0=Clear, 1=Rainy, 2=Stormy
- `risk_level` (string): Target variable (Low/Medium/High)

### 2. Training the Model
```bash
cd backend
python train_model.py
```

This will:
- Load data from `backend/data/delivery_data.csv`
- Train a RandomForestClassifier
- Save the model to `backend/ml_models/risk_model.pkl`
- Display training accuracy

### 3. Testing the Model
```bash
python test_model.py
```

This runs sample predictions to verify the model works correctly.

## API Endpoints

### Predict Risk
```bash
curl -X POST "http://127.0.0.1:8000/predict_risk" \
  -H "Content-Type: application/json" \
  -d '{
    "id": 1,
    "distance": 15.5,
    "traffic_level": 3,
    "delivery_time": 30,
    "weather_condition": 1,
    "lat": 12.9716,
    "lng": 77.5946
  }'
```

**Response:**
```json
{
  "id": 1,
  "risk_level": "Medium",
  "probability": 0.85
}
```

### Retrain Model
```bash
curl -X POST "http://127.0.0.1:8000/retrain"
```

## Risk Level Logic
The model classifies deliveries based on:
- **High Risk**: High traffic (4-5) OR stormy weather (2) OR combination of factors
- **Medium Risk**: Moderate traffic (3) OR rainy weather (1) OR moderate distance
- **Low Risk**: Low traffic (1-2) AND clear weather (0) AND short distance

## Files
- `train_model.py`: Training script
- `test_model.py`: Model testing script
- `data/delivery_data.csv`: Training dataset (500 samples)
- `ml_models/risk_model.pkl`: Trained model file
- `generate_data.py`: Script to create synthetic training data

## Next Steps
1. Replace the synthetic data with your real Tamil Nadu dataset
2. Retrain the model with your actual data
3. Adjust the risk calculation logic if needed
4. Monitor model performance with real feedback