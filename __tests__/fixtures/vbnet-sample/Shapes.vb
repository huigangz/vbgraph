Imports System

Namespace Shapes

    ''' <summary>Anything with a measurable area and a display name.</summary>
    Public Interface IShape
        Function Area() As Double
        ReadOnly Property Name As String
    End Interface

    ''' <summary>Abstract base type shared by every concrete shape.</summary>
    Public MustInherit Class Shape
        Implements IShape

        Private ReadOnly _name As String

        ''' <summary>Seeds the immutable display name. (Sub New)</summary>
        Protected Sub New(label As String)
            _name = label
        End Sub

        Public ReadOnly Property Name As String Implements IShape.Name
            Get
                Return _name
            End Get
        End Property

        Public MustOverride Function Area() As Double Implements IShape.Area

        ''' <summary>Human-readable one-liner for this shape.</summary>
        Public Overridable Function Describe() As String
            Return Name & " has area " & Area().ToString()
        End Function

    End Class

    ''' <summary>A width-by-height rectangle.</summary>
    Public Class Rectangle
        Inherits Shape

        Public Property Width As Double
        Public Property Height As Double

        Public Sub New(w As Double, h As Double)
            MyBase.New("rectangle")
            Width = w
            Height = h
        End Sub

        Public Overrides Function Area() As Double
            Return Width * Height
        End Function

    End Class

    ''' <summary>A rectangle whose sides are equal.</summary>
    Public Class Square
        Inherits Rectangle

        Public Sub New(side As Double)
            MyBase.New(side, side)
        End Sub

    End Class

End Namespace
