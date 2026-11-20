---
name: organize-downloads
tools: fs.list, fs.move
folders: ~/Downloads
schedule: 0 18 * * 5
---
List the files in my Downloads folder. Propose moving PDFs into a "PDFs" subfolder,
images into "Images", and installers (.exe, .dmg, .pkg) into "Installers".
Never touch folders. Each move needs my approval.
