# Your life's centre of mass

**Where in the world are you centred?**

It's not a philosophical question: it's a geographical one!

I hope you enjoy a little web-app I used to fill a flight. It takes as input places you've spent time (and how long at each) and calculates where the time-weighted mean geographic centre of all those points falls.

I originally did this offline (see offline.ipynb) using an image of the Earth (earth.jpeg) I had lying around from a supervision. However, I liked the concept and wanted to make it more accessible and engaging.

lthough it's how I taught myself to code, my css/javascript is a little rusty: enter LLMs! A few prompts later and we have a pretty, fully-functioning interactive site.

**Is this useful? No. Is it interesting? Maybe.**

I'm a born-and-raised Brit with a lot of Antipodean friends who are currently living in London – and I'm currently off to visit their side of the world – so I've been wondering: how much time tips the balance? For how long would I have to stay in, say, Cairns to drag my centre of mass as far as the Mediterranean? The Middle East? India??

**How about you? Where does yours fall?**

## How it works

| Feature | Implementation |
|---|---|
| Maps | [MapLibre GL](https://maplibre.org) + [OpenFreeMap Liberty](https://openfreemap.org) |
| Forward geocode | [Open-Meteo](https://open-meteo.com/en/docs/geocoding-api) |
| Reverse geocode | [BigDataCloud](https://www.bigdatacloud.com/docs/api/free-reverse-geocode-to-city-api) client API |
| Centre of mass | Time-weighted average on the planetary sphere (duration lived at each place) |
| Spread | Time-weighted root mean squared angular distance from the CoM (ie. 0 if all points coincide, bigger with additional spread), indicated via a gold ring. Mathematically, it's $\sigma = \sqrt((\sum_i t_i \times  \theta_i) / \sum_i t_i$) where $t$ is the time spent at each of $i$ locations |
| Nearest settlement | Reverse geocode of the centre of mass (cached in `localStorage` to keep things fast) |
| Time | Duration at each place: days, months, or years. The same place can be added more than once with different durations. |

## Notebook

Ass the name suggests, [`offline.ipynb`](offline.ipynb) contains the original offline working that got me thinking about this implementation.  Was originally was using a csv populated with guessed coordinates!
