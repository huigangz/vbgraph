Imports System.Collections.Generic
Imports VbnetSample.Geometry
Imports VbnetSample.Shapes

Namespace Catalog

    ''' <summary>A named, mutable collection of shapes.</summary>
    Public Class ShapeCatalog

        Private ReadOnly _shapes As New List(Of IShape)()

        ''' <summary>Display title for this catalog.</summary>
        Public Property Title As String

        ''' <summary>Fallback title — `Friend` + `Shared` for visibility/static coverage.</summary>
        Friend Shared ReadOnly DefaultTitle As String = "Untitled"

        ''' <summary>Builds an untitled catalog. (parameterless Sub New)</summary>
        Public Sub New()
            Title = DefaultTitle
        End Sub

        ''' <summary>Builds a catalog with an explicit title. (overloaded Sub New)</summary>
        Public Sub New(title As String)
            Me.Title = title
        End Sub

        Public Sub Add(shape As IShape)
            _shapes.Add(shape)
        End Sub

        Public Function Count() As Integer
            Return _shapes.Count
        End Function

        ''' <summary>
        ''' Calls ShapeMath.TotalArea at two distinct lines on purpose — the
        ''' regression fixture for the edge-dedup line/col unique-key invariant.
        ''' </summary>
        Public Function Summary() As String
            Dim area As Double = ShapeMath.TotalArea(_shapes)
            Dim doubled As Double = ShapeMath.TotalArea(_shapes) * 2
            Return Title & " total=" & area.ToString() & " doubled=" & doubled.ToString()
        End Function

        ''' <summary>Factory that returns a catalog pre-loaded with two shapes.</summary>
        Public Shared Function BuildDefault() As ShapeCatalog
            Dim catalog As New ShapeCatalog()
            catalog.Add(New Rectangle(2.0, 3.0))
            catalog.Add(New Square(4.0))
            Return catalog
        End Function

    End Class

End Namespace
