"""Differential test: lcu/compat/appx_xml.mjs against xml.etree.ElementTree (as used by lcu/windows.py)."""
import io
import json
import random
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compat_support as S  # noqa: E402

RUNNER = S.ROOT / 'tests/compat/run_appx_xml.mjs'

REAL = (
    '<?xml version="1.0" encoding="utf-8"?>\r\n'
    '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" '
    'xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" '
    'xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" '
    'IgnorableNamespaces="uap rescap">\r\n'
    '  <Identity Name="OpenAI.Codex" Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B" '
    'Version="26.917.9434.0" ProcessorArchitecture="x64" />\r\n'
    '  <Properties><DisplayName>ChatGPT</DisplayName><!-- c --><PublisherDisplayName>OpenAI</PublisherDisplayName>'
    '<Logo>Assets\\StoreLogo.png</Logo></Properties>\r\n'
    '  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" '
    'MaxVersionTested="10.0.22621.0" /></Dependencies>\r\n'
    '  <Applications><Application Id="App" Executable="app\\ChatGPT.exe" EntryPoint="Windows.FullTrustApplication">'
    '<uap:VisualElements DisplayName="ChatGPT" Description="d &amp; e" BackgroundColor="transparent" '
    'Square150x150Logo="a.png" Square44x44Logo="b.png"/></Application></Applications>\r\n'
    '  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>\r\n'
    '</Package>\r\n')

HANDWRITTEN = [
    '<a:b:c/>', '<:a/>', '<a:/>', '<a:b xmlns:a="u"/>', '<a:b:c xmlns:a="u"/>', '<a b:c="1" xmlns:b="u"/>',
    '<a xmlns:a=""/>', '<a xmlns=""/>', '<a xmlns:xml="http://www.w3.org/XML/1998/namespace"/>', '<a xmlns:xml="x"/>',
    '<a xmlns:xmlns="x"/>', '<a xmlns="http://www.w3.org/XML/1998/namespace"/>',
    '<a xmlns:p="http://www.w3.org/2000/xmlns/"/>', '<a xml:lang="en"/>',
    '<a xmlns:x="u" xmlns:y="u" x:q="1" y:q="2"/>', '<a x="1" x="2"/>', '<a x="1"y="2"/>', '<a x=1/>', '<a x/>',
    '<a x="<"/>', '<a x="&amp;&lt;&#65;&#x41;"/>', '<a x="&foo;"/>', '<a x="&#X41;"/>', '<a x="&#0;"/>',
    '<a x="&#xD800;"/>', '<a x="&#1;"/>', '<a x="\t\n"/>', '<a x="&#9;&#10;"/>', '<a x="\r\n\r"/>', '<a>]]></a>',
    '<a>&#x10FFFF;</a>', '<a>&#x110000;</a>', '<a><!-- -- --></a>', '<a><!-- a ---></a>', '<a><!--a--></a>',
    '<a><?xml x?></a>', '<a><?XML x?></a>', '<a><?xml-s x?></a>', '<a><?p:q x?></a>', '<a><?p?></a>',
    '<a><?p x?></a>', '<a><?px?x?></a>', '<a><? p?></a>', '<a><?p></a>',
    '<?xml version="1.0"?><a/>', ' <?xml version="1.0"?><a/>', '<?xml version="1.1"?><a/>',
    '<?xml version="2.0"?><a/>', '<?xml version="abc"?><a/>', '<?xml version=""?><a/>',
    '<?xml version="1.0" encoding="utf8"?><a/>', '<?xml version="1.0" encoding="UTF-16"?><a/>',
    '<?xml version="1.0" encoding="latin-1"?><a/>', '<?xml version="1.0" encoding="ISO-8859-1"?><a/>',
    '<?xml version="1.0" encoding="ascii"?><a/>', '<?xml version="1.0" encoding="us-ascii"?><a/>',
    '<?xml version="1.0" standalone="yes"?><a/>', '<?xml version="1.0" standalone="maybe"?><a/>',
    '<?xml encoding="utf-8" version="1.0"?><a/>', '<?xml version="1.0" ?><a/>', "<?xml version='1.0'?><a/>",
    '<?xml version="1.0" encoding="utf-8" standalone="no"?><a/>', '<?xml version="1.0" standalone="no" encoding="utf-8"?><a/>',
    '<?xml version="1.0"encoding="utf-8"?><a/>', '<?xml?><a/>', '<?xml ?><a/>', '<?xml version="1.0" foo="x"?><a/>',
    '<?xml version="1.0"?>\n<a/>', '<?xml version="1.0"?><?xml version="1.0"?><a/>',
    '<!DOCTYPE a><a/>', '<!DOCTYPE a SYSTEM "x.dtd"><a>&e;</a>', '<!DOCTYPE a SYSTEM "x.dtd"><a/>',
    '<!DOCTYPE a PUBLIC "x" "y"><a/>', '<!DOCTYPE a PUBLIC "x"><a/>', '<!DOCTYPE a SYSTEM><a/>', '<!DOCTYPE><a/>',
    '<a/><!DOCTYPE a>', '<!DOCTYPE a><!DOCTYPE a><a/>', '<!doctype a><a/>', '<!DOCTYPE  a  ><a/>',
    '', '   ', '<a>', '<a></b>', '<a/><b/>', '<a/>x', '<a/> <!-- c --> <?p?>', 'x<a/>', '<a><![CDATA[x]]></a>',
    '<![CDATA[x]]><a/>', '<a>&lt;</a>', '<a>&</a>', '<a x="a&b"/>', '<a>\x00</a>', '<a>\x01</a>', '<a>\x0b</a>',
    '<a>\ufffe</a>', '<a>\ufffd</a>', '<a\n/>', '<a / >', '<a/ >', '<a></a >', '< a/>', '<a b = "1" />', '<1a/>',
    '<a-b.c/>', '<a b="1" c = \'2\'/>', '<a b="\'"/>', "<a b='\"'/>", '<a>\r\n</a>',
    '<\u00e9/>', '<a \u00e9="1"/>', '<a\u00b7/>', '<\u00b7a/>', '<a\u0300/>', '<a>\u2028</a>',
    '<a:a xmlns:a="u" a:x="1" x="2"/>', '<a xmlns:a="u"><a:Identity Name="n" a:Name="m"/></a>',
    '<Package xmlns="u"><Identity Name="n"/></Package>', '<a xmlns="u"><b xmlns=""><Identity Name="x"/></b></a>',
    '<a xmlns:b:c="u"/>', '<a :b="1"/>', '<a b:="1" xmlns:b="u"/>', '<a xmlns:="u"/>', '<a xmlns:1="u"/>',
    '<a xmlns:b="u" xmlns:b="v"/>', '<a xmlns:b="u"></b:a></a>', '<a:b xmlns:a="u"></a:c>', '<xml:a/>',
    '<a b="&quot;&apos;"/>', '<a b="&#x20;"/>', '<a b="&#x;"/>', '<a b="&#;"/>', '<a b="&amp"/>', '<a b="&AMP;"/>',
    '<a>text &amp text</a>', '<a>>]></a>', '<a>]]</a>', '<a>]]]></a>', '<a><![CDATA[]]]]></a>', '<a><![CDATA[x</a>',
    '<a><!---></a>', '<a><!----></a>', '<a><!--></a>', '<a><!x></a>', '<a><??></a>', '<a><?p\tx?></a>',
    '<a/><?p?>', '<a/><!--c-->', '<a/><![CDATA[x]]>', '<a/>&amp;', '<a/>\n', '<a/>\x00', '<?p?><a/>', '<!--c--><a/>',
    '\n<a/>', '<a b="1" b="1"/>', '<A/>', '<a></A>', '<a><b></a></b>', '<a><b></b>', '<a/ ', '<a', '<', '<a b', '<a b=',
    '<a b="', '<a b="1', '<a b="1"', '<a b="1"/', '<a>text', '<a><', '<a></', '<a></a', '<a></a ',
    '<a\u2c00/>', '<a\U00010000/>', '<\U00010000/>', '<a\U000f0000/>', '<a\U0001f600/>', '<a b="\U0001f600"/>',
    '<a>\U0001f600</a>', '<a>\ufdd0</a>', '<a>\U0001fffe</a>', '<a>\x7f</a>', '<a>\x85</a>', '<a\u00d7/>', '<\u00d7/>',
]

BINARY = [
    b'\xef\xbb\xbf<a/>', b'\xef\xbb\xbf<?xml version="1.0"?><a/>', b'\xff\xfe<\x00a\x00/\x00>\x00',
    b'\xfe\xff\x00<\x00a\x00/\x00>', b'<\x00a\x00/\x00>\x00', b'\x00<\x00a\x00/\x00>', b'<a>\xff</a>',
    b'<?xml version="1.0" encoding="iso-8859-1"?><a>\xe9</a>', b'<?xml version="1.0" encoding="us-ascii"?><a>\xe9</a>',
    b'<?xml version="1.0" encoding="utf-8"?><a>\xe9</a>', b'\xef\xbb\xbf\xef\xbb\xbf<a/>', b'<a>\xed\xa0\x80</a>',
    b'<a>\xf4\x90\x80\x80</a>', b'<a>\xc0\x80</a>', b'<a>\xc3\xa9</a>',
    '<?xml version="1.0" encoding="utf-16"?><a/>'.encode('utf-16'),
    '<?xml version="1.0" encoding="utf-8"?><a/>'.encode('utf-16'),
    '<?xml version="1.0"?><a x="\u00e9\U0001f600"/>'.encode('utf-16'),
    '<?xml version="1.0"?><a x="\u00e9"/>'.encode('utf-16-be'),
    b'\xff\xfe<\x00a\x00>\x00\x00\xd8<\x00/\x00a\x00>\x00',
    b'<?xml version="1.0" encoding="latin-1"?><a b="\xe9\xff"/>',
]

IDENTITY = ('<Package><Identity Name="OpenAI.Codex" Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B" '
            'Version="1.2.3.4" ProcessorArchitecture="x64"/></Package>')

# .port/reviews/port-hosts.md R8-R10, R13 (probes-hosts/windows/xml_differential.py, selection_differential.py).
REVIEW = {
    'doctype-public-illegal-char': ('<!DOCTYPE Package PUBLIC "<" "local.dtd">' + IDENTITY).encode(),
    'doctype-public-illegal-tab': ('<!DOCTYPE Package PUBLIC "\t" "local.dtd">' + IDENTITY).encode(),
    'utf16-wrong-endian-declaration': ('<?xml version="1.0" encoding="UTF-16BE"?>' + IDENTITY).encode('utf-16'),
    'utf16-right-endian-declaration': ('<?xml version="1.0" encoding="UTF-16LE"?>' + IDENTITY).encode('utf-16-le'),
    'long-char-reference': IDENTITY.replace('1.2.3.4', '&#00000000000000049;.2.3.4').encode(),
    'valid-internal-subset': ('<!DOCTYPE Package [<!ENTITY version "1.2.3.4">]>' +
                              IDENTITY.replace('1.2.3.4', '&version;')).encode(),
    'valid-cp1252': ('<?xml version="1.0" encoding="cp1252"?>' + IDENTITY).encode(),
    'cp1252-value': ('<?xml version="1.0" encoding="cp1252"?>' + IDENTITY.replace('x64"', 'x64" E="\u20ac"')).encode('cp1252'),
    'cp1252-undefined-byte': b'<?xml version="1.0" encoding="cp1252"?><a x="\x81"/>',
    'long-encoding-declaration': ('<?xml version="1.0"' + ' ' * 600 + 'encoding="ISO-8859-1"?>' +
                                  IDENTITY.replace('Name="OpenAI.Codex"', 'Name="OpenAI.Codex" Extra="\u00e9"')).encode('latin1'),
    'long-encoding-declaration-different-value': ('<?xml version="1.0"' + ' ' * 600 + 'encoding="ISO-8859-1"?>' +
        IDENTITY.replace('Name="OpenAI.Codex"', 'Name="OpenAI.Codex" Extra="\u00e9"')).encode('utf8'),
    'unknown-codec': ('<?xml version="1.0" encoding="never-an-encoding"?>' + IDENTITY).encode(),
    'unknown-codec-case': ('<?xml version="1.0" encoding="Never-An-Encoding"?>' + IDENTITY).encode(),
    'multibyte-codec': ('<?xml version="1.0" encoding="shift_jis"?>' + IDENTITY).encode(),
    'bytes-codec': ('<?xml version="1.0" encoding="rot13"?>' + IDENTITY).encode(),
    'expat-refused-codec': ('<?xml version="1.0" encoding="cp037"?>' + IDENTITY).encode(),
    'undefined-codec': ('<?xml version="1.0" encoding="undefined"?>' + IDENTITY).encode(),
    'idna-codec': ('<?xml version="1.0" encoding="idna"?>' + IDENTITY).encode(),
    'koi8-codec': ('<?xml version="1.0" encoding="koi8_r"?><a x="\xc1"/>').encode('latin1'),
    'utf8-alias-handler': b'<?xml version="1.0" encoding="utf8"?><a x="\xc3\xa9"/>',
    'bom-and-cp1252': b'\xef\xbb\xbf<?xml version="1.0" encoding="cp1252"?><a/>',
    'bom-and-latin1': b'\xef\xbb\xbf<?xml version="1.0" encoding="ISO-8859-1"?><a/>',
    'bom-and-unknown': b'\xef\xbb\xbf<?xml version="1.0" encoding="nope"?><a/>',
    'utf16-and-cp1252': ('<?xml version="1.0" encoding="cp1252"?><a/>').encode('utf-16'),
    'utf16-and-unknown': ('<?xml version="1.0" encoding="nope"?><a/>').encode('utf-16'),
}

DTD = [
    '<!DOCTYPE a [<!ENTITY e "v">]><a x="&e;">&e;</a>', '<!DOCTYPE a [<!ENTITY e "<b/>">]><a>&e;</a>',
    '<!DOCTYPE a [<!ENTITY e "<b/>">]><a x="&e;"/>', '<!DOCTYPE a [<!ENTITY e "<b>">]><a>&e;</b></a>',
    '<!DOCTYPE a [<!ENTITY e "&f;"><!ENTITY f "1">]><a x="&e;"/>', '<!DOCTYPE a [<!ENTITY e "&e;">]><a x="&e;"/>',
    '<!DOCTYPE a [<!ENTITY e "&#38;amp;">]><a x="&e;"/>', '<!DOCTYPE a [<!ENTITY e "&#60;">]><a x="&e;"/>',
    '<!DOCTYPE a [<!ENTITY e "&#38;#60;">]><a x="&e;"/>', '<!DOCTYPE a [<!ENTITY e "a\tb">]><a x="&e;"/>',
    '<!DOCTYPE a [<!ENTITY e "a&#9;b">]><a x="&e;"/>', '<!DOCTYPE a [<!ENTITY e "1"><!ENTITY e "2">]><a x="&e;"/>',
    '<!DOCTYPE a [<!ENTITY e SYSTEM "x">]><a>&e;</a>', '<!DOCTYPE a [<!ENTITY e SYSTEM "x">]><a x="&e;"/>',
    '<!DOCTYPE a [<!ENTITY e SYSTEM "x" NDATA n>]><a>&e;</a>', '<!DOCTYPE a [<!ENTITY % p "x">]><a/>',
    '<!DOCTYPE a [<!ENTITY % p "x"> %p;]><a/>', '<!DOCTYPE a [<!ENTITY % p "<!ENTITY e \'v\'>"> %p;]><a x="&e;"/>',
    '<!DOCTYPE a [<!ENTITY e "%p;">]><a/>', '<!DOCTYPE a [<!ATTLIST a x CDATA "d">]><a/>',
    '<!DOCTYPE a [<!ATTLIST a x CDATA #FIXED "d">]><a/>', '<!DOCTYPE a [<!ATTLIST a x CDATA #FIXED "d">]><a x="e"/>',
    '<!DOCTYPE a [<!ATTLIST a x NMTOKENS "d">]><a x="  p   q  "/>', '<!DOCTYPE a [<!ATTLIST a x CDATA "d">]><a x="  p   q  "/>',
    '<!DOCTYPE a [<!ATTLIST a x ID #IMPLIED>]><a x=" p "/>', '<!DOCTYPE a [<!ATTLIST a x (p|q) "p">]><a/>',
    '<!DOCTYPE a [<!ATTLIST a xmlns CDATA "u">]><a/>', '<!DOCTYPE a [<!ATTLIST a x CDATA "d" x CDATA "e">]><a/>',
    '<!DOCTYPE a [<!ATTLIST a x CDATA "d"><!ATTLIST a x CDATA "e">]><a/>', '<!DOCTYPE a [<!ATTLIST a x CDATA "<">]><a/>',
    '<!DOCTYPE a [<!ATTLIST a x CDATA>]><a/>', '<!DOCTYPE a [<!ATTLIST a x FOO "d">]><a/>',
    '<!DOCTYPE a [<!ELEMENT a ANY>]><a/>', '<!DOCTYPE a [<!ELEMENT a (b|c)*>]><a/>',
    '<!DOCTYPE a [<!ELEMENT a (#PCDATA|b)*>]><a/>', '<!DOCTYPE a [<!ELEMENT a (#PCDATA|b)>]><a/>',
    '<!DOCTYPE a [<!ELEMENT a (b,c|d)>]><a/>', '<!DOCTYPE a [<!ELEMENT a (b)+>]><a/>', '<!DOCTYPE a [<!ELEMENT a FOO>]><a/>',
    '<!DOCTYPE a [<!ELEMENT a>]><a/>', '<!DOCTYPE a [<!NOTATION n SYSTEM "x">]><a/>', '<!DOCTYPE a [<!NOTATION n PUBLIC "x">]><a/>',
    '<!DOCTYPE a [<!-- c --><?pi x?>]><a/>', '<!DOCTYPE a [ <!ENTITY e "v"> ] ><a x="&e;"/>', '<!DOCTYPE a [<!ENTITY e "v">]x><a/>',
    '<!DOCTYPE a [<!FOO>]><a/>', '<!DOCTYPE a SYSTEM "y" [<!ENTITY e "v">]><a x="&e;"/>', '<!DOCTYPE a [<!ENTITY lt "<">]><a x="&lt;"/>',
    '<!DOCTYPE a [<!ENTITY amp "x">]><a x="&amp;"/>', '<!DOCTYPE a [<!ENTITY e "]]>">]><a>&e;</a>',
    '<!DOCTYPE a [<!ENTITY e "<!--c-->">]><a>&e;</a>', '<!DOCTYPE a [<!ENTITY e"v">]><a/>', '<!DOCTYPE a [<!ENTITY e "x" NDATA n>]><a/>',
    '<!DOCTYPE a [<!ENTITY e SYSTEM "x">]><a/>', '<!DOCTYPE a [<!ENTITY e PUBLIC "p" "x">]><a/>',
    '<!DOCTYPE a [<!ENTITY e PUBLIC "<" "x">]><a/>', '<!DOCTYPE a [<!ENTITY a:b "x">]><a x="&a:b;"/>',
    '<!DOCTYPE a [<!ATTLIST a b:c CDATA "d" xmlns:b CDATA "u">]><a/>', '<!DOCTYPE a [<!ENTITY e "x">]><a>&e;&e;</a>',
    '<?xml version="1.0" standalone="yes"?><!DOCTYPE a SYSTEM "x"><a>&e;</a>', '<!DOCTYPE a SYSTEM "x"><a x="&e;"/>',
    '<?xml version="1.0" standalone="yes"?><!DOCTYPE a SYSTEM "x"><a x="&e;"/>',
    '<!DOCTYPE a [<!ENTITY % p SYSTEM "x"> %p;]><a>&e;</a>', '<!DOCTYPE a [<!ENTITY % p SYSTEM "x"> %p;]><a x="&e;"/>',
    '<!DOCTYPE a [<!ENTITY e "&f;">]><a x="&e;"/>', '<!DOCTYPE a [<!ENTITY e "&f;">]><a/>', '<!DOCTYPE a [<!ENTITY e "&#0;">]><a/>',
    '<!DOCTYPE a [<!ENTITY e "&#xZ;">]><a/>', '<!DOCTYPE a [<!ENTITY e "&;">]><a/>', '<!DOCTYPE a [<!ENTITY e "&">]><a/>',
    '<!DOCTYPE a [<!ENTITY e "<">]><a/>', '<!DOCTYPE a [<!ENTITY e "<">]><a>&e;</a>', '<!DOCTYPE a [<!ENTITY e "x">]><a>&e</a>',
    '<!DOCTYPE a [<!ATTLIST a x CDATA "&e;"><!ENTITY e "v">]><a/>', '<!DOCTYPE a [<!ENTITY e "v"><!ATTLIST a x CDATA "&e;">]><a/>',
    '<!DOCTYPE a [<!ATTLIST a x NMTOKEN #IMPLIED>]><a x=" p\tq "/>', '<!DOCTYPE a [<!ATTLIST a x CDATA #REQUIRED>]><a/>',
    '<!DOCTYPE a [<!ATTLIST b x CDATA "d">]><a><b/></a>', '<!DOCTYPE a [<!ATTLIST p:b x CDATA "d">]><a xmlns:p="u"><p:b/></a>',
    '<!DOCTYPE a [<!ATTLIST a x NOTATION (n) "n">]><a/>', '<!DOCTYPE a [<!ENTITY  e  "v">]><a/>',
    '<!DOCTYPE a[<!ENTITY e "v">]><a x="&e;"/>', '<!DOCTYPE a [<!ENTITY e "x"> <!ENTITY f "&e;&e;">]><a x="&f;"/>',
    '<!DOCTYPE a [<!ENTITY e "<b x=\'&#38;#60;\'/>">]><a>&e;</a>', '<!DOCTYPE a [<!ENTITY e "<b x=\'&#60;\'/>">]><a>&e;</a>',
    '<!DOCTYPE a [<!ENTITY e "x">]><a><![CDATA[&e;]]></a>', '<!DOCTYPE a [<!ENTITY e "<?xml x?>">]><a>&e;</a>',
    '<!DOCTYPE a [<!ENTITY e "<a/>">]><a/>&e;', '<!DOCTYPE a [<!ENTITY e "<Identity Name=\'n\'/>">]><a>&e;</a>',
    '<!DOCTYPE Package [<!ATTLIST Identity Version CDATA "9.9.9.9">]>' + IDENTITY.replace(' Version="1.2.3.4"', ''),
    '<!DOCTYPE a [<!ENTITY % p "x"> %p; <!ENTITY e "v"><!ATTLIST a y CDATA "d">]><a x="&e;"/>',
    '<?xml version="1.0" standalone="yes"?><!DOCTYPE a [<!ENTITY % p "x"> %p; <!ENTITY e "v">]><a x="&e;"/>',
    '<!DOCTYPE a [%p;]><a/>', '<!DOCTYPE a [<!ENTITY % p "x"> %p ;]><a/>', '<!DOCTYPE a SYSTEM"x"><a/>',
    '<!DOCTYPE a PUBLIC "x""y"><a/>', '<!DOCTYPE a [<!ELEMENT a ( b , c )>]><a/>', '<!DOCTYPE a [<!ELEMENT a (#PCDATA)>]><a/>',
    '<!DOCTYPE a [<!ELEMENT a (#PCDATA)*>]><a/>', '<!DOCTYPE a [<!ELEMENT a (b|(c,d)+)?>]><a/>',
    '<!DOCTYPE a [<!ELEMENT a EMPTY >]><a/>', '<!DOCTYPE a [<!ELEMENT a:b EMPTY>]><a/>', '<!DOCTYPE a [<!ELEMENT a ( #PCDATA | b )*>]><a/>',
    '<!DOCTYPE a [<!ATTLIST a x CDATA "1"y CDATA "2">]><a/>', '<!DOCTYPE a [<!ATTLIST a x (p | q ) "q" >]><a/>',
    '<!DOCTYPE a [<!ATTLIST a x (1|2) "1">]><a/>', '<!DOCTYPE a [<!ATTLIST a x IDS "1">]><a/>', '<!DOCTYPE a [<!ATTLIST a>]><a/>',
    '<!DOCTYPE a [<!ATTLIST a x CDATA #FIXED"d">]><a/>', '<!DOCTYPE a [<!ATTLIST a x CDATA "&#x20; p &#x20;">]><a/>',
    '<!DOCTYPE a [<!ATTLIST a x NMTOKEN "&#x20; p &#x20;">]><a/>', '<!DOCTYPE a [<!ENTITY e " s ">]><a x="&e;"/>',
    '<!DOCTYPE a [<!ENTITY e " s "><!ATTLIST a x NMTOKEN #IMPLIED>]><a x="&e;"/>',
    '<!DOCTYPE a [<!ENTITY e "x\ny">]><a x="&e;"/>', '<!DOCTYPE a [<!ENTITY e "x\r\ny">]><a x="&e;"/>',
    '<!DOCTYPE a [<!NOTATION n SYSTEM "x"><!ENTITY e SYSTEM "y" NDATA n>]><a x="&e;"/>',
    '<!DOCTYPE a [<!ENTITY % p SYSTEM "x" NDATA n>]><a/>', '<!DOCTYPE a [<!NOTATION a:b SYSTEM "x">]><a/>',
    '<!DOCTYPE a [<!NOTATION n PUBLIC "x" "y">]><a/>', '<!DOCTYPE a [<!NOTATION n>]><a/>', '<!DOCTYPE a [<?xml x?>]><a/>',
    '<!DOCTYPE a [<!ENTITY e "\u00e9">]><a x="&e;"/>', '<!DOCTYPE a [<!ENTITY e \'"\'>]><a x="&e;"/>',
    '<!DOCTYPE a [<!ENTITY e "&#x26;#x26;amp;">]><a x="&e;"/>', '<!DOCTYPE a [<!ENTITY e "&#x26;">]><a x="&e;"/>',
    '<!DOCTYPE a [<!ENTITY e "&#x26;">]><a>&e;</a>', '<!DOCTYPE a [<!ENTITY e "&#x26;amp;">]><a>&e;</a>',
]

DTD_BASE = ('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE Package SYSTEM "x.dtd" [\n'
            '  <!ENTITY name "OpenAI.Codex">\n  <!ENTITY % pe "x">\n'
            '  <!ATTLIST Identity ProcessorArchitecture NMTOKEN "x64" Extra CDATA #FIXED "&name;">\n'
            '  <!ELEMENT Package (Identity, Properties?)>\n  <!NOTATION n PUBLIC "p">\n]>\n'
            '<Package xmlns="u"><Identity Name="&name;" Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B" '
            'Version="&#49;.2.3.4"/><Properties/></Package>\n')

DTD_BASE2 = ('<?xml version="1.0" standalone="no"?>\n<!DOCTYPE p:Package [\n'
             '  <!NOTATION gif SYSTEM "image/gif">\n  <!ENTITY pic SYSTEM "a.gif" NDATA gif>\n'
             '  <!ENTITY v "1.2.&#51;.4">\n  <!ENTITY id "<p:Identity Name=\'OpenAI.Codex\' Version=\'&v;\'/>">\n'
             '  <!ENTITY % ext SYSTEM "ext.dtd">\n  <!ATTLIST p:Identity Publisher CDATA '
             '"CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B" ProcessorArchitecture (x64|arm64) "x64" Kind NOTATION (gif) #IMPLIED>\n'
             '  <!ELEMENT p:Package (#PCDATA|p:Identity)*>\n  <!-- c --><?pi data?>\n]>\n'
             '<p:Package xmlns:p="urn:p">text &v; <![CDATA[&x;]]>&id;</p:Package>\n')

DTD_ALPHABET = ['<!ENTITY ', '<!ATTLIST ', '<!ELEMENT ', '<!NOTATION ', '%pe;', '&name;', '&#x31;', '&#0049;',
                '#FIXED ', '#IMPLIED', '#REQUIRED', 'NMTOKEN', 'CDATA', 'SYSTEM', 'PUBLIC', 'NDATA', '"', "'", '(',
                ')', '|', ',', '*', '+', '?', '[', ']', '>', '<', '%', '&', ';', ' ', '\t', '\n', 'standalone="yes" ']

ALPHABET = ['<', '>', '/', '"', "'", '=', '&', ';', '#', 'x', ' ', '\n', '\t', '\r', ':', '-', '!', '?', '[', ']',
            'a', 'Identity', 'xmlns', 'xmlns:a', 'a:', '&amp;', '&#65;', '&#x0;', '<!--', '-->', '--', '<![CDATA[',
            ']]>', '<?', '?>', '\u00e9', '\x01', '\ufffe', '\U0001f600', '\u00b7', '1', 'Name="x"']


def expected(data):
    """ElementTree's verdict: ERR for ParseError, EXC:<class>:<message> for any other exception, else the attrs."""
    try:
        root = ET.parse(io.BytesIO(data)).getroot()
    except ET.ParseError:
        return 'ERR'
    except Exception as exc:  # noqa: BLE001 - LookupError, ValueError, UnicodeError... propagate in windows.py
        text = str(exc).replace('\\', '\\\\').replace('\r', '\\r').replace('\n', '\\n')
        return f'EXC:{type(exc).__name__}:{text}'
    node = next((n for n in root.iter() if n.tag.rsplit('}', 1)[-1] == 'Identity'), None)
    if node is None:
        return 'OK:null'
    return 'OK:' + json.dumps(sorted([k, v] for k, v in node.attrib.items() if not k.startswith('{')),
                              separators=(',', ':'), ensure_ascii=False)


def mutants(count, seed, base=REAL, alphabet=ALPHABET):
    rng = random.Random(seed)
    for _ in range(count):
        text = base
        for _ in range(rng.randint(1, 3)):
            position = rng.randrange(len(text) + 1)
            kind = rng.random()
            if kind < 0.45:
                text = text[:position] + rng.choice(alphabet) + text[position:]
            elif kind < 0.75:
                text = text[:position] + text[position + rng.randint(1, 6):]
            else:
                text = text[:position] + rng.choice(alphabet) + text[position + 1:]
        yield text.encode('utf-8', 'surrogatepass')


class AppxXmlDifferentialTests(unittest.TestCase):
    def setUp(self):
        if not S.NODE:
            self.skipTest('node is not installed')

    def compare(self, documents):
        lines = ''.join(json.dumps({'hex': d.hex()}) + '\n' for d in documents)
        done = subprocess.run([S.NODE, str(RUNNER)], input=lines, capture_output=True, text=True, timeout=300)
        self.assertEqual(done.returncode, 0, done.stderr)
        actual = done.stdout.splitlines()
        self.assertEqual(len(actual), len(documents))
        failures = []
        for document, got in zip(documents, actual):
            want = expected(document)
            if got.startswith('CRASH') or (want == 'ERR') != got.startswith('ERR:') or \
                    (want != 'ERR' and want != got):
                failures.append((document[:200], want, got[:200]))
        self.assertEqual(failures[:15], [], f'{len(failures)} of {len(documents)} differ')

    def test_real_shaped_manifest(self):
        self.compare([REAL.encode(), REAL.replace('\r\n', '\n').encode(), REAL.encode('utf-16'),
                      b'\xef\xbb\xbf' + REAL.encode()])

    def test_handwritten_corpus(self):
        self.compare([c.encode('utf-8', 'surrogatepass') for c in HANDWRITTEN] + BINARY)

    def test_mutations_of_a_real_manifest(self):
        self.compare(list(mutants(4000, 20261005)))

    def test_review_cases(self):
        self.compare(list(REVIEW.values()))

    def test_dtd_corpus(self):
        self.compare([c.encode() for c in DTD] + [DTD_BASE.encode(), DTD_BASE2.encode()])

    def test_mutations_of_an_entity_manifest(self):
        self.compare(list(mutants(4000, 20261007, DTD_BASE2, DTD_ALPHABET + ALPHABET)))

    def test_mutations_of_a_dtd_manifest(self):
        self.compare(list(mutants(4000, 20261006, DTD_BASE, DTD_ALPHABET + ALPHABET)))


if __name__ == '__main__':
    unittest.main()
