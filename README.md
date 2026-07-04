# PS Store Avatar Adder

A Tampermonkey userscript to add classic PS3/PS4 avatars to your PlayStation Store cart, including legacy items that are no longer listed in the web store.

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension for your web browser.
2. Open the [ps3-avatar-adder.user.js]([ps3-avatar-adder.user.js](https://raw.githubusercontent.com/yungtry/ps3avatars/refs/heads/main/ps3-avatar-adder.user.js) file, click **Raw** on GitHub, and install the script.
3. Visit the [PlayStation Store](https://store.playstation.com/) and make sure you are logged in.

## Tutorial

Follow these steps to use the script:

1. Click the circular controller symbols button in the bottom left corner of the PlayStation Store page to open the panel.
2. **Capture the API Hash**: The script requires a session-specific API hash to make requests. To capture it, simply add any standard item (such as a game [preorders do not work]) to your cart using the regular store buttons on the page. The status indicator in the panel will turn green and display the captured hash.
3. Remove the game from the cart
4. Paste the Avatar Content ID (for example, `EP0082-CUSA02487_00-FFXIVPIXAVATAR00`) into the input field.
5. Select your store region.
6. Click **Add to Cart**.
7. Check your official cart on the website to verify and complete the checkout.
8. Repeat step 4 for the next avatar.

*Note: You can delete the captured hash at any time in the Advanced settings section to recapture it.*

## Troubleshooting (Manual Hash)

If the automatic capture does not trigger:

1. Press `F12` and open the **Network** tab, filtered by **Fetch/XHR**.
2. Add any item to the cart on the store page.
3. Search for a network request named `op`.
4. Inspect the Request Payload or Body of the `op` request to find `sha256Hash` (a 64-character string).
5. Copy it, expand the **Advanced (Hash)** section in the script panel, paste the hash, and click **Save hash**.

## Finding Avatar Content IDs

- **Product URLs**: Look at web URLs of legacy PlayStation Store pages where the Content ID is part of the link.
- **Databases**: Use third-party community databases like [SerialStation](https://serialstation.com/), [PSNA](https://psna.online/EDAT-FILES) or [PSDeals](https://psdeals.net/) to lookup Content IDs by game name.

## License

This project is licensed under the PolyForm Noncommercial License 1.0.0. Under this license, you are free to run, copy, modify, and distribute the script for noncommercial purposes, but any commercial use or distribution for sale is prohibited. See the [LICENSE](LICENSE) file for the full text.
