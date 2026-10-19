import { studioUrl } from "./config.js";

if (studioUrl) {
  const url = new URL(studioUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("The studio URL must use HTTPS without embedded credentials.");
  }
  const link = document.querySelector("#open-studio");
  link.href = url.href;
  link.hidden = false;
  document.querySelector("#status").textContent = "Open your hosted studio and sign in with your private studio credentials.";
}
