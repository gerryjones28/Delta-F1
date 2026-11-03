
import requests

url = "https://api.openf1.org/v1/location"

params = {
    "session_key": 9935,
    "driver_number": 1,
    "date>=": "2025-07-26T14:06:40",
    "date<=": "2025-07-26T14:06:50"
}

response = requests.get(url, params=params, timeout=30)

print("HTTP status:", response.status_code)
print("URL:", response.url)

if response.ok:
    data = response.json()
    print("Records:", len(data))
    print("First 3:", data[:3])
else:
    print("Error:", response.text[:300])
