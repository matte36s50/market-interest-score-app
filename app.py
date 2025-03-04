import streamlit as st
import pandas as pd
import matplotlib.pyplot as plt
import requests
from bs4 import BeautifulSoup

# Function to scrape Bring a Trailer auction data
def fetch_bat_data():
    url = "https://bringatrailer.com/auctions/"
    response = requests.get(url)
    soup = BeautifulSoup(response.text, 'html.parser')
    
    # Extract auction data (simplified for now)
    listings = soup.find_all('div', class_='listing-row')
    data = []
    for listing in listings[:50]:  # Limit to 50 for now
        title = listing.find('h3').text.strip()
        bids = listing.find('span', class_='bid-count').text.strip()
        data.append({"Title": title, "Bids": bids})
    
    return pd.DataFrame(data)

# Function to scrape Cars & Bids auction data
def fetch_cnb_data():
    url = "https://carsandbids.com/past-auctions/"
    response = requests.get(url)
    soup = BeautifulSoup(response.text, 'html.parser')
    
    # Extract auction data (simplified for now)
    listings = soup.find_all('div', class_='listing-card')
    data = []
    for listing in listings[:50]:
        title = listing.find('h2').text.strip()
        bids = listing.find('span', class_='bids').text.strip()
        data.append({"Title": title, "Bids": bids})
    
    return pd.DataFrame(data)

# Load dataset and aggregate from both sites
def load_data():
    bat_data = fetch_bat_data()
    cnb_data = fetch_cnb_data()
    
    # Merge and process auction data
    all_data = pd.concat([bat_data, cnb_data], ignore_index=True)
    all_data['Brand'] = all_data['Title'].apply(lambda x: x.split()[0])  # Extract brand from title
    brand_counts = all_data.groupby('Brand').size().reset_index(name='Auction Count')
    
    return brand_counts

def plot_market_interest(df):
    df.set_index("Brand", inplace=True)
    df.sort_values("Auction Count", ascending=False, inplace=True)
    df.plot(kind='bar', figsize=(12, 6), legend=False)
    plt.title("Market Interest Score by Brand")
    plt.xlabel("Brand")
    plt.ylabel("Number of Auctions")
    plt.xticks(rotation=90)
    st.pyplot(plt)

# Streamlit App Layout
st.title("Market Interest Score Dashboard")
st.write("This app tracks Market Interest Scores for top automotive brands based on Bring a Trailer and Cars & Bids auctions.")

data = load_data()
plot_market_interest(data)

# Display data table
st.subheader("Market Interest Scores by Brand")
st.dataframe(data)
