from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
import pandas as pd
import joblib
import os

def train_and_save_model(data_path="backend/data/delivery_data.csv", 
                         rf_model_path="backend/ml_models/rf_risk_model.joblib",
                         lr_model_path="backend/ml_models/lr_risk_model.joblib"):
    
    if not os.path.exists(data_path):
        # If running from within backend dir
        data_path = "data/delivery_data.csv"
        rf_model_path = "ml_models/rf_risk_model.joblib"
        lr_model_path = "ml_models/lr_risk_model.joblib"
        
    if not os.path.exists(data_path):
        print(f"Data not found at {data_path}. Please ensure data exists.")
        return None, None

    df = pd.read_csv(data_path)

    # Prepare features and target
    features = ["distance", "traffic_level", "delivery_time", "weather_condition", 
                "delivery_day", "distance_deviation", "order_deviation"]
    X = df[features]
    y = df["risk_level"]

    # Split data
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    # Scaling for Logistic Regression
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    # 1. Train Random Forest
    rf_model = RandomForestClassifier(n_estimators=100, random_state=42)
    rf_model.fit(X_train, y_train)
    rf_accuracy = rf_model.score(X_test, y_test)
    print(f"Random Forest accuracy: {rf_accuracy:.2f}")

    # 2. Train Logistic Regression
    lr_model = LogisticRegression(max_iter=1000, random_state=42)
    lr_model.fit(X_train_scaled, y_train)
    lr_accuracy = lr_model.score(X_test_scaled, y_test)
    print(f"Logistic Regression accuracy: {lr_accuracy:.2f}")

    # Ensure directory exists
    os.makedirs(os.path.dirname(rf_model_path), exist_ok=True)

    # Save models and scaler
    joblib.dump(rf_model, rf_model_path)
    joblib.dump(lr_model, lr_model_path)
    joblib.dump(scaler, os.path.join(os.path.dirname(rf_model_path), "scaler.joblib"))
    
    # Save the original risk_model.pkl for compatibility if needed
    joblib.dump(rf_model, "backend/ml_models/risk_model.pkl")

    print(f"Models saved successfully.")
    
    return rf_model, rf_accuracy

if __name__ == "__main__":
    train_and_save_model()
