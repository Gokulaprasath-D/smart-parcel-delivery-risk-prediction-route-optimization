import requests
import json

# Test cases
test_cases = [
    {
        "name": "Low Risk Delivery",
        "data": {
            "id": 1,
            "distance": 5.2,
            "traffic_level": 1,
            "delivery_time": 15,
            "weather_condition": 0,
            "lat": 12.9716,
            "lng": 77.5946
        }
    },
    {
        "name": "Medium Risk Delivery",
        "data": {
            "id": 2,
            "distance": 15.5,
            "traffic_level": 3,
            "delivery_time": 30,
            "weather_condition": 1,
            "lat": 12.9716,
            "lng": 77.5946
        }
    },
    {
        "name": "High Risk Delivery",
        "data": {
            "id": 3,
            "distance": 25.8,
            "traffic_level": 5,
            "delivery_time": 55,
            "weather_condition": 2,
            "lat": 12.9716,
            "lng": 77.5946
        }
    }
]

print("Testing Machine Learning Model Predictions")
print("=" * 50)

for test_case in test_cases:
    try:
        response = requests.post(
            "http://127.0.0.1:8000/predict_risk",
            json=test_case["data"]
        )
        
        if response.status_code == 200:
            result = response.json()
            print(f"✅ {test_case['name']}")
            print(f"   Risk Level: {result['risk_level']}")
            print(f"   Probability: {result['probability']:.2f}")
            print()
        else:
            print(f"❌ {test_case['name']} - Error: {response.status_code}")
            
    except Exception as e:
        print(f"❌ {test_case['name']} - Exception: {str(e)}")

print("Model testing completed!")