# Three.js 0.164.1

These files replace the dashboard's existing CDN imports of Three.js 0.164.1
so the 3D renderer, model loader, and orbit controls can be cached for offline
range use. No package installation or build step is required.

Source: the official [three npm package](https://www.npmjs.com/package/three/v/0.164.1),
[versioned archive](https://registry.npmjs.org/three/-/three-0.164.1.tgz).
Upstream: [mrdoob/three.js](https://github.com/mrdoob/three.js).
The upstream MIT license is included in [LICENSE](LICENSE).

Archive integrity (SHA-512, base64):

```text
iC/hUBbl1vzFny7f5GtqzVXYjMJKaTPxiCxXfrvVdBi1Sf+jhd1CAkitiFwC7mIBFCo3MrDLJG97yisoaWig0w==
```

Included files are `build/three.module.min.js`, `GLTFLoader.js`,
`OrbitControls.js`, and `BufferGeometryUtils.js` in their original package
directories. The only source changes are the three example modules' imports
from `three`, replaced with `../../../build/three.module.min.js` so native
browser modules resolve locally without an import map.

To update, retrieve a specific upstream archive, verify its published integrity,
copy the same files and license, and adjust those imports. Check for new loader
dependencies and add them to the service worker's precache list. Update this
version/provenance note and run the tests plus the dashboard, Bow Shop, and
alignment views online and after stopping the local HTTP server.
