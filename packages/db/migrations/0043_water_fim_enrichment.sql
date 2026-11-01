-- Add NOAA Flood Inundation Mapping context to the existing Water collection.
-- Only replace the seeded copy: a description explicitly customized in the
-- database remains the sysop's version.

update collections
   set description = 'Too much water and too little: NOAA river and tide gauges at or above their action stages, with observed and forecast levels, vertical datums, flood thresholds, station notes and source attribution where published; coastal water levels against each tide station’s flood thresholds; and the US Drought Monitor’s weekly read on how much of each state is dry and how badly. NOAA’s NWPS gauge page reports that Flood Inundation Mapping services now cover nearly 100% of the U.S. (9/24 update). Water records link to the FIM services and technical resources, with map availability for each gauge where NOAA publishes it. Gauge readings and mapped inundation are different products, and neither assesses flood risk for an individual property, determines a FEMA flood zone or establishes insurance eligibility. The collection also follows every NOAA buoy’s wave height, period and direction, beside the National Weather Service’s surf-zone forecasts.'
 where slug = 'water'
   and description = 'Too much water and too little, measured rather than forecast: every NOAA river gauge at or above its action stage with the height in feet and the flood category behind the warning, the observed level at tide stations on every US coast against the height at which each one floods, and the US Drought Monitor’s weekly read on how much of each state is dry and how badly. Then the sea itself — every NOAA buoy’s wave height, period and direction, which is what a surf report is made of, beside the National Weather Service’s own surf zone forecast saying what it means for anyone standing on the beach.';

update sources
   set name = replace(name, 'River gauges in flood:', 'NOAA river and tide gauges in flood:'),
       description = 'NOAA river and tide gauges at or above their action stages, with the measured level, vertical datum, NWS flood thresholds, station notes and source attribution when published. Includes whether each gauge has a Flood Inundation Mapping layer and links to NOAA’s national FIM services and technical resources. Keyless.'
 where adapter = 'nwps-river-gauges'
   and name like 'River gauges in flood:%'
   and (description is null or description = 'Every NOAA-forecast river gauge at or above its action stage, observed and forecast, with the height in feet and the flood category the National Weather Service assigns it. The number behind a flood warning. Keyless.');
