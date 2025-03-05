import streamlit as st
import pandas as pd
import matplotlib.pyplot as plt
import requests
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
import time
import random

# Function to scrape Bring a Trailer auction data using Selenium
def fetch_bat_data():
    url = "https://bringatrailer.com/auctions/"
    
    options = Options()
    options.add_argument("--headless")  # Run in headless mode (no GUI)
    options.add_argument("--disable-gpu")
    options.add_argument("--no-sandbox")
    
    driver = webdriver.Chrome(options=options)
    driver.get(url)
    
    # Wait for JavaScript content to load
    time.sleep(5)
    
    soup = BeautifulSoup(driver.page_source, "html.parser")
    driver.quit()
    
    listings = soup.find_all("div", class_="auction-item-container")
    data = []
    
    for listing in listings[:50]:
        title_tag = listing.find("div", class_="auction-title")
        bids_tag = listing.find("span", class_="bid-count")
        
        if title_tag and bids_tag:
            title = title_tag.text.strip()
            bids = bids_tag.text.strip()
            data.append({"Title": title, "Bids": bids})
    
    return pd.DataFrame(data)

# Function to scrape Cars & Bids auction data using headers
def fetch_cnb_data():
    url = "https://carsandbids.com/past-auctions/"
    
    user_agents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.109 Safari/537.36",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 15_2 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Version/15.2 Mobile/15E148 Safari/537.36"
    ]
    
    headers = {
        "User-Agent": random.choice(user_agents),
        "Referer": "https://carsandbids.com",
        "Accept-Language": "en-US,en;q=0.9"
    }
    
    response = requests.get(url, headers=headers)
    
    if response.status_code != 200:
        st.error(f"Error fetching Cars & Bids data: {response.status_code}")
        return pd.DataFrame()
    
    soup = BeautifulSoup(response.text, 'html.parser')
    listings = soup.find_all("div", class_="listing-card")
    data = []
    
    for listing in listings[:50]:
        title_tag = listing.find("h2")
        bids_tag = listing.find("span", class_="bids")
        
        if title_tag and bids_tag:
            title = title_tag.text.strip()
            bids = bids_tag.text.strip()
            data.append({"Title": title, "Bids": bids})
    
    return pd.DataFrame(data)

# Load dataset and aggregate from both sites
def load_data():
    bat_data = fetch_bat_data()
    cnb_data = fetch_cnb_data()
    
    st.write("Bring a Trailer Data Sample:")
    st.write(bat_data.head())
    st.write("Cars & Bids Data Sample:")
    st.write(cnb_data.head())
    
    all_data = pd.concat([bat_data, cnb_data], ignore_index=True)
    
    if 'Title' not in all_data.columns:
        st.error("Error: 'Title' column not found in scraped data. Check auction site structure.")
        return pd.DataFrame()
    
    all_data['Brand'] = all_data['Title'].apply(lambda x: x.split()[0])
    brand_counts = all_data.groupby('Brand').size().reset_index(name='Auction Count')
    
    return brand_counts

def plot_market_interest(df):
    if df.empty:
        st.error("No auction data available. Check if the scraping functions are working correctly.")
        return
    
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
