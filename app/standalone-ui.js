// Browser-17 on its own: small things the player does otherwise.
// (Plugins and Color and background are the player's own windows, shown by the sound host.)
"use strict";

/** The sound host's state: without it the volume and Plugins have nothing to work with. */
function onSoundStatus(ok, text) {
  for (const id of ["mute", "volume", "plugins"]) $(id).disabled = !ok;
  if (text) notice(text);
}

if (INIT.standalone && !INIT.has_player) $("places").style.display = "none";
if (INIT.standalone) document.title = "Browser-17";
