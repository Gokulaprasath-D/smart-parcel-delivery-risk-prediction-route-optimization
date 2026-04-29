import pandas as pd
import numpy as np
import os
 
 
# Set seed for reproducibility
np.random.seed(42)

n_samples = 1000

# Generating raw features
distances = np.random.uniform(1, 50, n_samples)
mean_distance = np.mean(distances)

data = {
    "distance": distances,
    "traffic_level": np.random.randint(1, 6, n_samples),
    "delivery_time": np.random.uniform(5, 120, n_samples),
    "weather_condition": np.random.randint(0, 3, n_samples),
    "delivery_day": np.random.randint(0, 7, n_samples),  # 0=Mon, 6=Sun
    "distance_deviation": np.abs(distances - mean_distance),
    "order_deviation": np.random.uniform(0, 10, n_samples) # Deviation in delivery order sequence
}

df = pd.DataFrame(data)

def calculate_risk(row):
    # Risk calculation logic
    score = (row["traffic_level"] * 10) + (row["weather_condition"] * 15) + (row["distance"] * 0.3) + (row["distance_deviation"] * 0.5) + (row["order_deviation"] * 0.8)
    
    if score > 80:
        return "High"
    elif score > 45:
        return "Medium"
    else:
        return "Low"

df["risk_level"] = df.apply(calculate_risk, axis=1)

# Ensure directory exists
os.makedirs("backend/data", exist_ok=True)

# Save to CSV
df.to_csv("backend/data/delivery_data.csv", index=False)
print("Synthetic delivery data with engineered features generated.")
