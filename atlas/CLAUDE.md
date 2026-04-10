# Atlas of Peculiar Galaxies

## Adding a new galaxy

The atlas is a single static HTML file (`index.html`). Each galaxy is a `<div class="plate">` block inside `<div class="plates">`.

### Steps

1. **Get the image.** Download a 256x256 cutout from the Legacy Survey viewer:
   ```
   https://www.legacysurvey.org/viewer/cutout.jpg?ra=RA&dec=DEC&layer=ls-dr10&pixscale=0.25&size=256
   ```
   The user may provide custom cutout parameters (different center, pixscale, or layer). Save as `assets/image_NN.jpg` where NN is the next sequential number.

2. **Look up the SIMBAD ID.** Query SIMBAD by coordinates:
   ```
   https://simbad.u-strasbg.fr/simbad/sim-coo?Coord=RA+DEC&CooFrame=FK5&CooEpoch=2000&CooEqui=2000&Radius=1&Radius.unit=arcmin&submit=submit+query&OutputMode=LIST
   ```
   Use the closest match. Format as `NAME (TYPE)` (e.g. `LEDA 764105 (G)`). Use `&mdash;` if no match.

3. **Generate the similarity search URL.** Base64-encode this JSON (note lowercase `iq`):
   ```json
   {"iq":[[RA,DEC,0.025]],"iw":[1]}
   ```
   Use the SIMBAD coordinates (not the image cutout center) for the similarity search payload. The full URL is:
   ```
   https://astronolan-aion-search.hf.space/?s=BASE64_STRING
   ```

4. **Add the HTML block** before the closing `</div>` of `<div class="plates">`, following this template:

   ```html
   <div class="plate">
     <div class="plate-number">Image NN</div>
     <div class="img-frame"><a href="https://www.legacysurvey.org/viewer/?ra=RA&dec=DEC&zoom=15&layer=ls-dr10" target="_blank"><img src="assets/image_NN.jpg" alt="Image NN"></a></div>
     <div class="coords">RA RA_VAL &nbsp; Dec SIGN DEC_VAL</div>
     <div class="simbad-id">SIMBAD_ID (TYPE)</div>
     <div class="description">
       Description text here.
     </div>
     <div class="survey-tag">DESI Legacy DR10</div>
     <br><a class="viewer-link" href="https://www.legacysurvey.org/viewer/?ra=RA&dec=DEC&zoom=15&layer=ls-dr10" target="_blank">View in Legacy Survey</a>
     &nbsp;&middot;&nbsp;<a class="viewer-link" href="https://astronolan-aion-search.hf.space/?s=BASE64" target="_blank">Similarity Search</a>
   </div>
   ```

### Formatting conventions

- Positive declination: use `+` (e.g. `Dec +27.0713`)
- Negative declination: use `&minus;` HTML entity (e.g. `Dec &minus;26.7680`)
- Survey tag is either `DESI Legacy DR10` or `HSC DR3`
- HSC images use `layer=hsc-dr3` and typically `zoom=16` in viewer links
- Viewer link RA/Dec should match the image cutout center coordinates
- Always view the downloaded cutout image to verify it looks correct before adding
