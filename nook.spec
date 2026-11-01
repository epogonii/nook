%global app_id io.github.epogonii.nook

Name:           nook
Version:        1.1.1
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
%{_datadir}/icons/hicolor/512x512/apps/%{app_id}.png
%{_datadir}/icons/hicolor/symbolic/apps/%{app_id}-symbolic.svg
%{_metainfodir}/%{app_id}.metainfo.xml

%changelog
* Sun Nov 01 2026 Evghenii Pogonii <epogonii@gmail.com> - 1.1.1-1
- Screenshots with the new icon

* Sun Nov 01 2026 Evghenii Pogonii <epogonii@gmail.com> - 1.1.0-1
- A cozy room icon instead of the house
- Home can take another background for the dark style

* Sat Oct 31 2026 Evghenii Pogonii <epogonii@gmail.com> - 1.0.0-1
- First release
