# SPDX-License-Identifier: GPL-2.0-or-later

project('nook-app',
  version: '1.0.0',
  license: 'GPL-2.0-or-later',
  meson_version: '>= 1.0',
)

gnome = import('gnome')
i18n = import('i18n')

app_id = 'io.github.epogonii.nook-app'

prefix = get_option('prefix')
bindir = prefix / get_option('bindir')
datadir = prefix / get_option('datadir')
# main.js looks for the translations one level up, in datadir / 'locale'.
pkgdatadir = datadir / app_id

install_subdir('src',
  install_dir: pkgdatadir,
  exclude_files: ['nook-app.in'],
  strip_directory: true,
)

configure_file(
  input: 'src/nook-app.in',
  output: 'nook-app',
  configuration: {'pkgdatadir': pkgdatadir},
  install_dir: bindir,
  install_mode: 'rwxr-xr-x',
)

# The extension calls the bus name; the session bus starts the app from this.
configure_file(
  input: 'data' / app_id + '.service.in',
  output: app_id + '.service',
  configuration: {'bindir': bindir},
  install_dir: datadir / 'dbus-1' / 'services',
)

i18n.merge_file(
  input: 'data' / app_id + '.desktop',
  output: app_id + '.desktop',
  type: 'desktop',
  po_dir: 'po',
  install: true,
  install_dir: datadir / 'applications',
)
install_data('data' / app_id + '.metainfo.xml',
  install_dir: datadir / 'metainfo',
)
install_data('data' / app_id + '.gschema.xml',
  install_dir: datadir / 'glib-2.0' / 'schemas',
)
install_subdir('data/icons',
  install_dir: datadir,
)

subdir('po')

gnome.post_install(glib_compile_schemas: true)

test('schema', find_program('glib-compile-schemas'),
  args: ['--strict', '--dry-run', meson.project_source_root() / 'data'],
)
