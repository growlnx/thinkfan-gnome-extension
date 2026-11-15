PKG     := thinkfan-gnome-extension
UUID    := $(shell sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' gnome-extension/metadata.json)
VERSION := $(shell sed -n 's/^Version: //p' deb/$(PKG)/DEBIAN/control)
STAGE   := build/$(PKG)
DEB     := build/$(PKG)_$(VERSION)_all.deb
EXTDIR  := $(STAGE)/usr/share/gnome-shell/extensions/$(UUID)

.PHONY: deb install clean

deb: $(DEB)

# Staging in build/ keeps deb/ as source-only (static files); the extension
# and helper are copied in from gnome-extension/ and script/.
$(DEB): $(shell find deb gnome-extension script -type f)
	rm -rf $(STAGE)
	mkdir -p $(STAGE) $(EXTDIR) $(STAGE)/usr/bin
	cp -r deb/$(PKG)/. $(STAGE)/
	install -m 644 gnome-extension/extension.js gnome-extension/metadata.json $(EXTDIR)/
	install -m 755 script/thinkfan-set $(STAGE)/usr/bin/thinkfan-set
	find $(STAGE) -type d -exec chmod 755 {} +
	chmod 755 $(STAGE)/DEBIAN/postinst
	dpkg-deb --root-owner-group --build $(STAGE) $@

install: deb
	sudo apt install ./$(DEB)

clean:
	rm -rf build
