import os
import requests

game_name = "KeKeZin"
tag_line = "mawz"
api_key = os.environ["RIOT_API_KEY"]

url = f"https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/{game_name}/{tag_line}"
headers = {"X-Riot-Token": api_key}

response = requests.get(url, headers=headers)

if response.status_code == 200:
    data = response.json()
    print(f"PUUID encontrado: {data['puuid']}")
else:
    print(f"Error {response.status_code}: {response.text}")
