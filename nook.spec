%global app_id io.github.epogonii.nook

Name:           nook
Version:        1.0.0
Release:        1%{?dist}
Summary:        Control your smart home
License:        GPL-2.0-or-later
URL:            https://github.com/epogonii/nook
Source0:        %{url}/archive/v%{version}/%{name}-%{version}.tar.gz
BuildArch:      noarch

BuildRequires:  appstream
BuildRequires:  desktop-file-utils
BuildRequires:  gettext
BuildRequires:  glib2
BuildRequires:  meson
Requires:       gjs
Requires:       gtk4
Requires:       hicolor-icon-theme
Requires:       libadwaita
Requires:       libsecret
Requires:       openssl
# Camera pictures: rtspsrc, and an H.264 decoder.
Requires:       gstreamer1-plugins-good
Recommends:     gstreamer1-plugin-openh264
Recommends:     avahi
Recommends:     bluez

%description
Nook brings lights, plugs, sensors, cameras, air conditioners, TVs and
speakers together in one place. Its window shows every device by section and
room, signs in to the accounts and finds and pairs devices on the network.
With the Nook extension for GNOME Shell, the same devices are also in the
top bar.

%prep
%autosetup

%build
%meson
%meson_build

%install
%meson_install
%find_lang %{app_id}

%check
%meson_test
desktop-file-validate %{buildroot}%{_datadir}/applications/%{app_id}.desktop
appstreamcli validate --no-net %{buildroot}%{_metainfodir}/%{app_id}.metainfo.xml

%files -f %{app_id}.lang
%license LICENSE
%doc README.md
%{_bindir}/nook
%{_datadir}/%{app_id}/
%{_datadir}/applications/%{app_id}.desktop
%{_datadir}/dbus-1/services/%{app_id}.service
%{_datadir}/glib-2.0/schemas/%{app_id}.gschema.xml
%{_datadir}/icons/hicolor/scalable/apps/%{app_id}.svg
%{_datadir}/icons/hicolor/symbolic/apps/%{app_id}-symbolic.svg
%{_metainfodir}/%{app_id}.metainfo.xml

%changelog
* Sat Oct 31 2026 Evghenii Pogonii <epogonii@gmail.com> - 1.0.0-1
- First release
